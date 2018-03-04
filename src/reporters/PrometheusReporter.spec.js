'use strict'

const sinon = require('sinon')
const { expect } = require('chai')
const dedent = require('dedent')
const { Tags } = require('opentracing')
const { Tracer } = require('../tracer')
const PrometheusReporter = require('./PrometheusReporter')

describe('reporter/PrometheusReporter', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  describe('#constructor', () => {
    it('should create a PrometheusReporter', () => {
      const prometheusReporter = new PrometheusReporter()

      expect(prometheusReporter).to.have.property('_registry')
    })
  })

  describe('#reportFinish', () => {
    it('should skip operation metrics by tag value', function () {
      // init
      const prometheusReporter = new PrometheusReporter({
        ignoreTags: {
          [Tags.HTTP_URL]: /foo/
        }
      })
      const metricsOperationDurationSeconds = prometheusReporter._metricsOperationDurationSeconds()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(metricsOperationDurationSeconds, 'labels').callsFake(() => metricsStub)

      // generate data
      const tracer = new Tracer('service')

      const span = tracer.startSpan('my-operation')
      span.setTag(Tags.HTTP_URL, 'http://127.0.0.1/foo')
      clock.tick(100)
      span.finish()

      prometheusReporter.reportFinish(span)

      // assert
      expect(metricsOperationDurationSeconds.labels).to.have.callCount(0)
      expect(metricsStub.observe).to.have.callCount(0)
    })

    it('should observe operation metrics without parent', function () {
      // init
      const prometheusReporter = new PrometheusReporter()
      const metricsOperationDurationSeconds = prometheusReporter._metricsOperationDurationSeconds()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(metricsOperationDurationSeconds, 'labels').callsFake(() => metricsStub)

      // generate data
      const tracer = new Tracer('service')

      const span = tracer.startSpan('my-operation')
      clock.tick(100)
      span.finish()

      prometheusReporter.reportFinish(span)

      // assert
      expect(metricsOperationDurationSeconds.labels).to.have.callCount(1)
      expect(metricsOperationDurationSeconds.labels).to.be.calledWith('my-operation')

      expect(metricsStub.observe).to.have.callCount(1)
      expect(metricsStub.observe).to.be.calledWith(0.1)
    })

    it('should observe operation metrics with parent', function () {
      // init
      const prometheusReporter = new PrometheusReporter()
      const metricsOperationDurationSeconds = prometheusReporter._metricsOperationDurationSeconds()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(metricsOperationDurationSeconds, 'labels').callsFake(() => metricsStub)

      // generate data
      const parentTracer = new Tracer('parent-service')
      const tracer = new Tracer('service')

      const parentSpan1 = parentTracer.startSpan('parent-operation')
      const span1 = tracer.startSpan('my-operation', { childOf: parentSpan1 })
      clock.tick(100)
      span1.finish()

      const parentSpan2 = parentTracer.startSpan('parent-operation')
      const span2 = tracer.startSpan('my-operation', { childOf: parentSpan2 })
      clock.tick(300)
      span2.finish()

      prometheusReporter.reportFinish(span1)
      prometheusReporter.reportFinish(span2)

      // assert
      expect(metricsOperationDurationSeconds.labels).to.have.callCount(2)
      expect(metricsOperationDurationSeconds.labels).to.be.calledWith('my-operation')

      expect(metricsStub.observe).to.have.callCount(2)
      expect(metricsStub.observe).to.be.calledWith(0.1)
      expect(metricsStub.observe).to.be.calledWith(0.3)
    })

    it('should observe HTTP request metrics without parent', function () {
      // init
      const prometheusReporter = new PrometheusReporter()
      const httpRequestLatency = prometheusReporter._metricsHttpRequestLatency()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(httpRequestLatency, 'labels').callsFake(() => metricsStub)

      // generate data
      const tracer = new Tracer('service')

      const span = tracer.startSpan('http_request')
      span.setTag(Tags.HTTP_METHOD, 'GET')
      span.setTag(Tags.HTTP_STATUS_CODE, 200)
      span.setTag(Tags.HTTP_URL, 'http://localhost:9392/')
      span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_SERVER)
      clock.tick(100)
      span.finish()

      prometheusReporter.reportFinish(span)

      // assert
      expect(httpRequestLatency.labels).to.have.callCount(1)
      expect(httpRequestLatency.labels)
        .to.be.calledWith('HTTP-GET-/', 'false')

      expect(metricsStub.observe).to.have.callCount(1)
      expect(metricsStub.observe).to.be.calledWith(0.1)
    })

    it('should observe HTTP request metrics with parent', function () {
      // init
      const prometheusReporter = new PrometheusReporter()
      const httpRequestLatency = prometheusReporter._metricsHttpRequestLatency()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(httpRequestLatency, 'labels').callsFake(() => metricsStub)

      // generate data
      const parentTracer = new Tracer('parent-service')
      const tracer = new Tracer('service')

      const parentSpan1 = parentTracer.startSpan('parent-operation')
      const span1 = tracer.startSpan('http_request', { childOf: parentSpan1 })
      span1.setTag(Tags.HTTP_METHOD, 'GET')
      span1.setTag(Tags.HTTP_STATUS_CODE, 200)
      span1.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_SERVER)
      span1.setTag(Tags.HTTP_URL, 'http://localhost:9392/')
      clock.tick(100)
      span1.finish()

      const parentSpan2 = parentTracer.startSpan('parent-operation')
      const span2 = tracer.startSpan('http_request', { childOf: parentSpan2 })
      span2.setTag(Tags.HTTP_METHOD, 'POST')
      span2.setTag(Tags.HTTP_STATUS_CODE, 201)
      span2.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_SERVER)
      span2.setTag(Tags.HTTP_URL, 'http://localhost:9392/pets')
      clock.tick(300)
      span2.finish()

      prometheusReporter.reportFinish(span1)
      prometheusReporter.reportFinish(span2)

      // assert
      expect(httpRequestLatency.labels).to.have.callCount(2)
      expect(httpRequestLatency.labels).to.be.calledWith('HTTP-POST-/pets', 'false')

      expect(metricsStub.observe).to.have.callCount(2)
      expect(metricsStub.observe).to.be.calledWith(0.1)
      expect(metricsStub.observe).to.be.calledWith(0.3)
    })

    it('should skip client HTTP requests', function () {
      // init
      const prometheusReporter = new PrometheusReporter()
      const httpRequestLatency = prometheusReporter._metricsHttpRequestLatency()

      const metricsStub = {
        observe: this.sandbox.spy()
      }

      this.sandbox.stub(httpRequestLatency, 'labels').callsFake(() => metricsStub)

      // generate data
      const tracer = new Tracer('service')

      const span = tracer.startSpan('http_request')
      span.setTag(Tags.HTTP_METHOD, 'GET')
      span.setTag(Tags.HTTP_STATUS_CODE, 200)
      span.setTag(Tags.SPAN_KIND_RPC_SERVER, false) // or not set
      clock.tick(100)
      span.finish()

      prometheusReporter.reportFinish(span)

      // assert
      expect(httpRequestLatency.labels).to.have.callCount(0)
      expect(metricsStub.observe).to.have.callCount(0)
    })
  })

  describe('#metrics', () => {
    it('should have operation metrics initialized', () => {
      const reporter = new PrometheusReporter()

      expect(reporter.metrics()).to.be.equal(dedent`
        # HELP operations Duration of operations in second
        # TYPE operations histogram\n
      `)
    })
  })
})
