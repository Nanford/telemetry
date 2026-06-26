const ACTIVE_ALERT_RULE_WHERE = 'deleted_at IS NULL';

const resolveAlertRuleDeleteMode = (linkedAlertCount) => {
  const count = Number(linkedAlertCount) || 0;
  return count > 0 ? 'archive' : 'delete';
};

module.exports = {
  ACTIVE_ALERT_RULE_WHERE,
  resolveAlertRuleDeleteMode
};
