const assert = require('assert');

const { resolveAlertRuleDeleteMode } = require('../src/alert-rules');

assert.strictEqual(
  resolveAlertRuleDeleteMode(0),
  'delete',
  'rules without historical alerts can be physically deleted'
);

assert.strictEqual(
  resolveAlertRuleDeleteMode(3),
  'archive',
  'rules referenced by historical alerts should be archived'
);

console.log('alert-rule-deletion: OK');
