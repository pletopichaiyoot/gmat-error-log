'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { isPublicS3Url } = require('../../src/scraper-runner.js');

// A GMAT Club figure's URL is whatever a forum post's <img> points at, and the
// Node-side fallback fetch has no browser network rules — so it must refuse
// anything but public S3.
test('Node figure fetch accepts public S3 hosts only', () => {
  for (const url of [
    'https://s3.amazonaws.com/gmatclub_cdn/graph.png',
    'https://gmatclub-cdn.s3.amazonaws.com/x/graph.png',
    'https://bucket.s3.us-west-2.amazonaws.com/graph.png',
    'https://s3-us-west-2.amazonaws.com/bucket/graph.png',
  ]) assert.strictEqual(isPublicS3Url(url), true, url);

  for (const url of [
    'http://s3.amazonaws.com/bucket/graph.png',
    'https://127.0.0.1:4310/api/sessions',
    'http://localhost:9222/json',
    'https://169.254.169.254/latest/meta-data/',
    'https://s3.amazonaws.com.evil.example/graph.png',
    'https://evil-s3.amazonaws.com.example/graph.png',
    'https://example.com/s3.amazonaws.com/graph.png',
    'https://ec2-1-2-3-4.compute-1.amazonaws.com/graph.png',
    'not a url',
  ]) assert.strictEqual(isPublicS3Url(url), false, url);
});
