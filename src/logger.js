const db = require('./db');

function log(salesorderNo, action, success, detail, picklistNo) {
  const line = `[${new Date().toISOString()}] ${action} ${salesorderNo || ''}${picklistNo ? ` (${picklistNo})` : ''} ${success ? 'OK' : 'FAIL'} ${detail || ''}`;
  if (success) {
    console.log(line);
  } else {
    console.error(line);
  }
  db.logActivity(salesorderNo, action, success, detail, picklistNo);
}

module.exports = { log };
