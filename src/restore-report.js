/**
 * @license
 * [BSD-3-Clause](https://github.com/pryv/pryv-account-backup/blob/master/LICENSE)
 */

/**
 * Collects what a restore did, per resource: how many calls were sent, which
 * ones the server refused, and what was deliberately skipped. A batch call
 * answers each sub-call with either a result or an `{ error }` entry and never
 * throws, so without this a partially refused restore looked successful.
 */
class RestoreReport {
  constructor () {
    this.resources = {};
    this.notes = [];
  }

  _resource (name) {
    if (!this.resources[name]) {
      this.resources[name] = { sent: 0, failed: [], skipped: [] };
    }
    return this.resources[name];
  }

  /**
   * Record the answers of one batch: `calls[i]` was answered by `results[i]`.
   */
  recordBatch (name, calls, results) {
    for (let i = 0; i < calls.length; i++) {
      this.recordCall(name, idOfCall(calls[i]), results ? results[i] : null);
    }
  }

  /**
   * Record one answered call. Returns the server error, or null on success.
   */
  recordCall (name, id, result) {
    const resource = this._resource(name);
    resource.sent++;
    const error = errorOf(result);
    if (error) resource.failed.push({ id, error });
    return error;
  }

  /** A call that did not get an answer at all (thrown error). */
  recordFailure (name, id, error) {
    const resource = this._resource(name);
    resource.sent++;
    resource.failed.push({ id, error: normalizeError(error) });
  }

  /** Something deliberately not restored, with the reason. */
  recordSkip (name, id, reason) {
    this._resource(name).skipped.push({ id, reason });
  }

  note (text) {
    this.notes.push(text);
  }

  hasFailures () {
    return Object.values(this.resources).some((r) => r.failed.length > 0);
  }

  failureCount () {
    return Object.values(this.resources).reduce((n, r) => n + r.failed.length, 0);
  }

  /**
   * Human-readable summary. Lists the first few refusals per resource; the
   * full answers stay in the `res_<resource>.log` files.
   */
  toLines (maxListed = 5) {
    const lines = ['Restore summary:'];
    for (const [name, r] of Object.entries(this.resources)) {
      const ok = r.sent - r.failed.length;
      let line = '  ' + name + ': ' + ok + ' ok, ' + r.failed.length + ' refused';
      if (r.skipped.length > 0) line += ', ' + r.skipped.length + ' skipped';
      lines.push(line);
      for (const f of r.failed.slice(0, maxListed)) {
        lines.push('    refused ' + (f.id || '(no id)') + ': ' + describeError(f.error));
      }
      if (r.failed.length > maxListed) {
        lines.push('    ... and ' + (r.failed.length - maxListed) + ' more refusal(s)');
      }
      for (const s of r.skipped.slice(0, maxListed)) {
        lines.push('    skipped ' + (s.id || '(no id)') + ': ' + s.reason);
      }
      if (r.skipped.length > maxListed) {
        lines.push('    ... and ' + (r.skipped.length - maxListed) + ' more skipped');
      }
    }
    for (const n of this.notes) lines.push('  note: ' + n);
    return lines;
  }
}

function idOfCall (call) {
  const params = (call && call.params) || {};
  return params.id || params.oldId || null;
}

function errorOf (result) {
  if (result == null) return { id: 'no-result', message: 'no answer for this call' };
  if (result.error) return result.error;
  return null;
}

function normalizeError (err) {
  if (err && err.response && err.response.body && err.response.body.error) {
    return err.response.body.error;
  }
  if (err && err.innerObject && err.innerObject.id) return err.innerObject;
  return { id: 'exception', message: (err && err.message) || String(err) };
}

function describeError (error) {
  if (!error) return 'unknown error';
  return [error.id, error.message].filter(Boolean).join(': ') || 'unknown error';
}

module.exports = RestoreReport;
module.exports.errorOf = errorOf;
module.exports.normalizeError = normalizeError;
