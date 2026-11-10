'use strict';
// Capability hints only. Existing POST handlers remain the authority at execution.
function accountActions(account, row, { storageReady, verificationAvailable = true } = {}) {
  const actions=['inspect'];
  const idle=account.activeRequests===0 && !account.maintenanceOperation;
  const pending=account.runtime?.disabledReason==='pending_enrollment_qualification'
    || account.enrollmentQualificationRequired===true;
  if (account.identityDuplicate) return actions;
  if (storageReady!==true || !idle) return actions;
  if (row.login==='expired' || row.login==='unknown') actions.push('reauth');
  actions.push('check');
  if (account.health?.refreshable===true) actions.push('refresh');
  if (verificationAvailable && row.login==='valid' && !row.qualified) actions.push('verify');
  if (account.status==='disabled') {
    if (!pending && row.login==='valid' && row.qualified) actions.push('enable');
  } else actions.push('disable');
  actions.push('delete');
  return actions;
}
function recommendedAction(row, actions) {
  if (row.login==='expired') return actions.includes('refresh') ? 'refresh' : actions.includes('reauth') ? 'reauth' : 'inspect';
  if (row.login==='valid' && row.qualified!==true && actions.includes('verify')) return 'verify';
  if (row.state==='disabled' && actions.includes('enable')) return 'enable';
  return 'inspect';
}
module.exports={accountActions,recommendedAction};
