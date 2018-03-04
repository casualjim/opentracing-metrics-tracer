'use strict'

const assert = require('assert')
const { URL } = require('url')
const Prometheus = require('prom-client')
const { Tags } = require('opentracing')
const Span = require('../tracer/Span')

const DURATION_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const METRICS_NAME_OPERATION = 'operations'
const METRICS_NAME_REQUESTS = 'requests'
const METRICS_NAME_HTTP_REQUEST_LATENCY = 'request_latency'
const METRICS_NAME_HTTP_STATUS_CODES = 'http_requests'
const LABEL_PARENT_SERVICE_UNKNOWN = 'unknown'
const LABEL_OTHER = 'other'

const NORM_RE = /[^A-Za-z0-9\-_/.]/g
const NS_RE = /[.-]/g

/**
* Observe span events and expose them in Prometheus metrics format
* @class PrometheusReporter
*/
class PrometheusReporter {
  /**
  * @static getParentServiceKey
  * @param {Span} span
  * @return {String} parentService
  */
  static getParentService (span) {
    const spanContext = span.context()
    const parentService = spanContext.parentServiceKey() || LABEL_PARENT_SERVICE_UNKNOWN

    return parentService
  }

  /**
   * Normalizes an endpoint name
   * @static endpointName
   * @param {Span} span
   * @return {String} normalizedName
   */
  static endpointName (span) {
    const reqUrl = span.getTag(Tags.HTTP_URL)
    if (!reqUrl) {
      return LABEL_OTHER
    }
    const url = new URL(reqUrl)
    const scheme = url.protocol.slice(0, -1).toUpperCase()
    const method = span.getTag(Tags.HTTP_METHOD).toUpperCase()
    let path = url.pathname
    if (!path) {
      path = '/'
    }
    const name = `${scheme} ${method} ${path}`
    return name.replace(NORM_RE, '-')
  }

  /**
   * Normalizes a metric name
   * @static metricName
   * @param {String} name
   * @param {String} [namespace='']
   * @private
   * @return {String} normalizedName
   */
  static metricName (name, namespace = '') {
    const ns = (nm) => nm.replace(NS_RE, '_')

    if (!namespace) {
      return ns(name)
    } else if (name) {
      return ns(namespace)
    }
    return `${ns(namespace)}:${ns(name)}`
  }

  /**
   * converts the error tag from a span
   * @static errorValue
   * @private
   * @param {Span} span
   */
  static errorValue (span) {
    const err = span.getTag('error')
    if (!err || (typeof err === 'string' && err.toLowerCase() !== 'true')) {
      return 'false'
    }
    return 'true'
  }

  /**
   * negotiates if the span is for a http server request
   * @static isHttpServerSpan
   * @private
   * @param {Span} span
   * @return {Boolean}
   */
  static isHttpServerSpan (span) {
    const rpcServer = span.getTag(Tags.SPAN_KIND) === Tags.SPAN_KIND_RPC_SERVER
    const httpTags = !!(
      span.getTag(Tags.HTTP_URL) ||
      span.getTag(Tags.HTTP_METHOD) ||
      span.getTag(Tags.HTTP_STATUS_CODE)
    )
    return rpcServer && httpTags
  }

  /**
  * @constructor
  * @param {Object} [options={}]
  * @param {Object} [options.ignoreTags={}]
  * @returns {PrometheusReporter}
  */
  constructor ({ ignoreTags = {} } = {}) {
    this._registry = new Prometheus.Registry()
    this._options = {
      ignoreTags
    }

    // Initialize metrics
    this._metricsOperationDurationSeconds()
  }

  /**
  * Returns with the reporter's metrics in Prometheus format
  * @method metrics
  * @returns {Object} metrics
  */
  metrics () {
    return this._registry.metrics()
  }

  /**
  * Called by Tracer when a span is finished
  * @method reportFinish
  * @param {Span} span
  */
  reportFinish (span) {
    assert(span instanceof Span, 'span is required')

    // Ignore by tag value
    const isIgnored = Object.entries(this._options.ignoreTags).some(([tagKey, regexp]) => {
      const tagValue = span.getTag(tagKey)
      return tagValue && tagValue.match(regexp)
    })

    if (isIgnored) {
      return
    }

    // HTTP Request
    if (PrometheusReporter.isHttpServerSpan(span)) {
      this._reportHttpRequestFinish(span)
    } else {
      // Operation metrics
      this._reportOperationFinish(span)
    }
  }

  /**
  * Observe operation metrics
  * @method _reportOperationFinish
  * @private
  * @param {Span} span
  */
  _reportOperationFinish (span) {
    assert(span instanceof Span, 'span is required')

    this._metricsOperationDurationSeconds()
      .labels(span.operationName())
      .observe(span.duration() / 1000)
  }

  /**
  * Observe HTTP request metrics
  * @method _reportHttpRequestFinish
  * @private
  * @param {Span} span
  */
  _reportHttpRequestFinish (span) {
    assert(span instanceof Span, 'span is required')
    const endpoint = PrometheusReporter.endpointName(span)
    const err = PrometheusReporter.errorValue(span)

    this._recordHttpRequestMetrics(endpoint, err, span.duration() / 1000)
    this._recordHttpResponseMetrics(endpoint, parseInt(span.getTag(Tags.HTTP_STATUS_CODE), 10))
  }

  /**
   * Records request metrics
   * @method _recordHttpRequestMetrics
   * @private
   * @param {String} endpoint
   * @param {String} err
   * @param {Number} duration
   */
  _recordHttpRequestMetrics (endpoint, err, duration) {
    this._metricsHttpRequestCount().labels(endpoint, err).inc()
    this._metricsHttpRequestLatency().labels(endpoint, err).observe(duration)
  }

  /**
   * Records response related metrics
   * @param {String} endpoint
   * @param {Number} statusCode
   */
  _recordHttpResponseMetrics (endpoint, statusCode) {
    const mod = parseInt(statusCode / 100, 10)
    if (mod >= 2 && mod <= 5) {
      const metric = this._metricsHttpRequestStatusCodes()
      metric.labels(endpoint, `${mod}xx`).inc()
    }
  }

  /**
  * Singleton to get operation duration metrics
  * @method _metricsOperationDurationSeconds
  * @private
  * @return {Prometheus.Histogram} operationDurationSeconds
  */
  _metricsOperationDurationSeconds () {
    let operationDurationSeconds = this._registry.getSingleMetric(METRICS_NAME_OPERATION)

    if (!operationDurationSeconds) {
      operationDurationSeconds = new Prometheus.Histogram({
        name: METRICS_NAME_OPERATION,
        help: 'Duration of operations in second',
        labelNames: ['name'],
        buckets: DURATION_HISTOGRAM_BUCKETS,
        registers: [this._registry]
      })
    }

    return operationDurationSeconds
  }

  /**
  * Singleton to get HTTP request duration metrics
  * @method _metricsHttpRequestLatency
  * @private
  * @return {Prometheus.Histogram} httpRequestLatency
  */
  _metricsHttpRequestLatency () {
    let httpRequestLatency = this._registry.getSingleMetric(METRICS_NAME_HTTP_REQUEST_LATENCY)

    if (!httpRequestLatency) {
      httpRequestLatency = new Prometheus.Histogram({
        name: METRICS_NAME_HTTP_REQUEST_LATENCY,
        help: 'Duration of HTTP requests in second distinguished by their endpoint and error status',
        labelNames: ['endpoint', 'error'],
        buckets: DURATION_HISTOGRAM_BUCKETS,
        registers: [this._registry]
      })
    }

    return httpRequestLatency
  }

  /**
  * Singleton to get HTTP request count
  * @method _metricsHttpRequestCount
  * @private
  * @return {Prometheus.Counter} httpRequestCount
  */
  _metricsHttpRequestCount () {
    let httpRequestCount = this._registry.getSingleMetric(METRICS_NAME_REQUESTS)

    if (!httpRequestCount) {
      httpRequestCount = new Prometheus.Counter({
        name: METRICS_NAME_REQUESTS,
        help: 'Counts the number of requests made distinguished by their endpoint and error status',
        labelNames: ['endpoint', 'error'],
        registers: [this._registry]
      })
    }

    return httpRequestCount
  }

  /**
  * Singleton to get HTTP request count
  * @method _metricsHttpRequestStatusCodes
  * @private
  * @return {Prometheus.Counter} httpRequestStatusCodes
  */
  _metricsHttpRequestStatusCodes () {
    let httpRequestStatusCodes = this._registry.getSingleMetric(METRICS_NAME_HTTP_STATUS_CODES)

    if (!httpRequestStatusCodes) {
      httpRequestStatusCodes = new Prometheus.Counter({
        name: METRICS_NAME_HTTP_STATUS_CODES,
        help: 'Counts the responses distinguished by endpoint and status code bucket',
        labelNames: ['endpoint', 'status_code'],
        registers: [this._registry]
      })
    }

    return httpRequestStatusCodes
  }
}

PrometheusReporter.Prometheus = Prometheus
PrometheusReporter.LABEL_PARENT_SERVICE_UNKNOWN = LABEL_PARENT_SERVICE_UNKNOWN

module.exports = PrometheusReporter
