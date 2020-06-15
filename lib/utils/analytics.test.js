'use strict';

const { join } = require('path');
const { homedir } = require('os');
const BbPromise = require('bluebird');
const fse = require('fs-extra');
const proxyquire = require('proxyquire');
const { expect } = require('chai');

const cacheDirPath = join(homedir(), '.serverless', 'tracking-cache');

const isFilename = RegExp.prototype.test.bind(/^(?:\.[^.].*|\.\..+|[^.].*)$/);

describe('analytics', () => {
  let track;
  let sendPending;
  let expectedState = 'success';
  let usedUrl;
  let pendingRequests = 0;
  let concurrentRequestsMax = 0;

  const generateEvent = (type, timestamp = Date.now()) => {
    let data;
    switch (type) {
      case 'user':
        data = { data: { timestamp: Math.round(timestamp / 1000) } };
        break;
      case 'segment':
        data = { properties: { general: { timestamp } } };
        break;
      default:
        throw new Error('Unrecognized type');
    }
    return track(type, data);
  };
  before(() => {
    ({ track, sendPending } = proxyquire('./analytics.js', {
      './isTrackingDisabled': false,
      'node-fetch': url => {
        usedUrl = url;
        ++pendingRequests;
        if (pendingRequests > concurrentRequestsMax) concurrentRequestsMax = pendingRequests;
        return new BbPromise((resolve, reject) => {
          setTimeout(() => {
            switch (expectedState) {
              case 'success':
                return resolve({ status: 200, buffer: () => Promise.resolve(url) });
              case 'networkError':
                return reject(Object.assign(new Error('Network error'), { code: 'NETWORK_ERROR' }));
              case 'responseBodyError':
                return resolve({
                  status: 200,
                  buffer: () =>
                    Promise.reject(
                      Object.assign(new Error('Response body error'), {
                        code: 'RESPONSE_BODY_ERROR',
                      })
                    ),
                });
              default:
                throw new Error(`Unexpected state: ${expectedState}`);
            }
          }, 500);
        }).finally(() => --pendingRequests);
      },
    }));
  });

  it('Should ignore missing cacheDirPath', () =>
    sendPending().then(sendPendingResult => {
      expect(sendPendingResult).to.be.null;
      return generateEvent('segment').then(() => {
        expect(usedUrl).to.equal('https://tracking.serverlessteam.com/v1/track');
        return fse.readdir(cacheDirPath).then(dirFilenames => {
          expect(dirFilenames.filter(isFilename).length).to.equal(0);
        });
      });
    }));

  it('Should cache failed requests and rerun then with sendPending', () => {
    expectedState = 'networkError';
    return generateEvent('user')
      .then(() => {
        expect(usedUrl).to.equal('https://serverless.com/api/framework/track');
        return fse.readdir(cacheDirPath);
      })
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(1);
        expectedState = 'success';
        return sendPending();
      })
      .then(() => fse.readdir(cacheDirPath))
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(0);
      });
  });

  it('Should limit concurrent requests at sendPending', () => {
    expectedState = 'networkError';
    expect(pendingRequests).to.equal(0);
    let resolveServerlessExecutionSpan;
    const serverlessExecutionSpan = new BbPromise(
      resolve => (resolveServerlessExecutionSpan = resolve)
    );
    return Promise.all([
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
    ])
      .then(() => {
        return fse.readdir(cacheDirPath);
      })
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(7);
        expectedState = 'success';
        expect(pendingRequests).to.equal(0);
        concurrentRequestsMax = 0;
        return sendPending({ serverlessExecutionSpan });
      })
      .then(() => fse.readdir(cacheDirPath))
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(0);
        expect(concurrentRequestsMax).to.equal(3);
        resolveServerlessExecutionSpan();
        return serverlessExecutionSpan;
      });
  });

  it('Should not issue further requests after serverless execution ends', () => {
    expectedState = 'networkError';
    return Promise.all([
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
      generateEvent('user'),
    ])
      .then(() => {
        return fse.readdir(cacheDirPath);
      })
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(7);
        expectedState = 'success';
        return sendPending();
      })
      .then(() => fse.readdir(cacheDirPath))
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(4);
        return fse.emptyDir(cacheDirPath);
      });
  });

  it('Should ditch stale events at sendPending', () => {
    expectedState = 'networkError';
    expect(pendingRequests).to.equal(0);
    let resolveServerlessExecutionSpan;
    const serverlessExecutionSpan = new BbPromise(
      resolve => (resolveServerlessExecutionSpan = resolve)
    );
    return Promise.all([
      generateEvent('user', 0),
      generateEvent('user', 0),
      generateEvent('user'),
      generateEvent('user', 0),
      generateEvent('user'),
      generateEvent('user', 0),
      generateEvent('user', 0),
    ])
      .then(() => {
        return fse.readdir(cacheDirPath);
      })
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(7);
        expectedState = 'success';
        expect(pendingRequests).to.equal(0);
        concurrentRequestsMax = 0;
        return sendPending({ serverlessExecutionSpan });
      })
      .then(() => fse.readdir(cacheDirPath))
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(0);
        expect(concurrentRequestsMax).to.equal(2);
        resolveServerlessExecutionSpan();
        return serverlessExecutionSpan;
      });
  });

  it('Should ignore body procesing error', () => {
    expectedState = 'responseBodyError';
    return generateEvent('user')
      .then(() => {
        return fse.readdir(cacheDirPath);
      })
      .then(dirFilenames => {
        expect(dirFilenames.filter(isFilename).length).to.equal(0);
      });
  });
});
