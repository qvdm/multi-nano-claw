#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NanoClawStack } from '../lib/nanoclaw-stack';

const app = new cdk.App();

new NanoClawStack(app, 'NanoClawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || '172912611806',
    region: 'ca-central-1',
  },
});
