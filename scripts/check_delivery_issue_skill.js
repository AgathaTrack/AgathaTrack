#!/usr/bin/env node
'use strict';

const { validateDeliveryIssueSkill } = require('./lib/delivery_issue_skill_policy');

try {
  const result = validateDeliveryIssueSkill();
  console.log('check_delivery_issue_skill: delivery-issue skill mirrors OK');
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`check_delivery_issue_skill: ${error.message}`);
  process.exit(1);
}