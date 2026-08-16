/* =====================================================================
 *  REPLACE your existing doGet and doPost in Code.gs with these.
 *  (Same as yours, with the new routes added. Nothing else removed.)
 *  After pasting + adding LedgerSyncEndpoints.gs, deploy a New version.
 * ===================================================================== */

function doGet(e) {
  const p = e && e.parameter || {};
  const action = p.action || '';

  if (action === 'load')   return jsonResponse(loadData());
  if (action === 'today')  return jsonResponse({ ok: true, events: getTodayEvents() });
  if (action === 'ping')   return jsonResponse({ ok: true, message: 'Family Ledger v2 alive.' });

  // --- Ledger sync additions ---
  if (action === 'ics')                return ContentService.createTextOutput(buildIcsFromTasks_()).setMimeType(ContentService.MimeType.ICAL);
  if (action === 'google-import')      return jsonResponse(handleGoogleImport_(e));
  if (action === 'get-reminders')      return jsonResponse(getKV_('reminders', 'reminders'));
  if (action === 'get-notes')          return jsonResponse(getKV_('notes', 'notes'));
  if (action === 'get-when-possible')  return jsonResponse(getKV_('whenPossible', 'items'));
  if (action === 'get-subs')           return jsonResponse(getKV_('subs', 'subs'));
  if (action === 'get-morning-config') return jsonResponse(getMorningConfig_());

  return jsonResponse({ ok: true, message: 'Family Ledger v2 alive.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || (e && e.parameter && e.parameter.action) || '';

    if (action === 'save') {
      saveData(body.data);
      return jsonResponse({ ok: true });
    }

    // --- Ledger sync additions ---
    if (action === 'ai')                  return jsonResponse(handleAi_(body));
    if (action === 'save-reminders')      return jsonResponse(setKV_('reminders', body.reminders));
    if (action === 'subscribe-push')      return jsonResponse(handleSubscribePush_(body));
    if (action === 'google-search')       return jsonResponse(handleGoogleSearch_(body));
    if (action === 'save-notes')          return jsonResponse(setKV_('notes', body.notes));
    if (action === 'save-when-possible')  return jsonResponse(setKV_('whenPossible', body.items));
    if (action === 'save-subs')           return jsonResponse(setKV_('subs', body.subs));
    if (action === 'save-morning-config') return jsonResponse(saveMorningConfig_(body));
    if (action === 'morning-report')      return jsonResponse(handleMorningReport_(body));

    if (action === 'subscribe') {
      savePushSub(body.userId, body.userName, body.subscription);
      return jsonResponse({ ok: true });
    }
    if (action === 'unsubscribe') {
      removePushSub(body.userId);
      return jsonResponse({ ok: true });
    }
    if (action === 'saveUser') {
      saveUserProfile(body.userId, body.profile);
      return jsonResponse({ ok: true });
    }
    if (action === 'addTask') {
      return handleAddTask(body);
    }
    if (action === 'submitTaskFeedback') {
      return handleTaskFeedback(body);
    }
    if (action === 'saveRecurringSchedule') {
      return handleRecurringSchedule(body);
    }
    if (action === 'scanInboxForTasks') {
      return handleScanInboxForTasks(body);
    }
    if (action === 'getCalendarEvents') {
      return handleGetCalendarEvents(body);
    }
    if (action === 'getTasks') {
      return jsonResponse({ ok: true, tasks: getFilteredSortedTasks() });
    }
    if (action === 'getRecentlyCompleted') {
      return jsonResponse({ ok: true, tasks: loadRecentlyCompleted() });
    }
    if (action === 'completeTask') {
      const taskId = body.taskId, userId = body.userId, completedAt = body.completedAt || new Date().toISOString();
      moveTaskToCompleted(taskId, userId, completedAt);
      return jsonResponse({ ok: true });
    }
    if (action === 'snoozeTask') {
      updateTaskField(body.taskId, 'snoozeUntil', body.snoozeUntil || '');
      return jsonResponse({ ok: true });
    }
    if (action === 'updateTask') {
      const updates = body.updates || {};
      Object.keys(updates).forEach(function(k) { updateTaskField(body.taskId, k, updates[k]); });
      return jsonResponse({ ok: true });
    }
    if (action === 'savePushSubscription') {
      savePushSub(body.userId, body.userId, body.subscription);
      return jsonResponse({ ok: true });
    }
    if (action === 'getDetails') {
      const detailsStr = PropertiesService.getScriptProperties().getProperty('APP_DETAILS') || '[]';
      return jsonResponse({ ok: true, details: JSON.parse(detailsStr) });
    }
    if (action === 'saveDetails') {
      PropertiesService.getScriptProperties().setProperty('APP_DETAILS', JSON.stringify(body.details || []));
      return jsonResponse({ ok: true });
    }
    if (action === 'chat') return handleChat(body);

    return jsonResponse({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}
