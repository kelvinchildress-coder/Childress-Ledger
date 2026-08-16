/* =====================================================================
 *  Sunday email redesign — calm summary instead of the 100+ dump.
 * ---------------------------------------------------------------------
 *  In your Code.gs:
 *    1. REPLACE the existing sendWeeklyEmail() and buildEmailBody() with
 *       the versions below.
 *    2. ADD the two helper functions (effectiveDueDate_, daysToDue_).
 *    3. If you have previewWeeklyEmail(), change its
 *       buildEmailBody(thisWeek, settings) to buildEmailBody(data.tasks, settings).
 *  Then Deploy -> New version.
 * ===================================================================== */

// Roll a recurring past deadline forward to its next occurrence so annual
// items (birthdays, taxes) don't read as overdue or flood the summary.
function effectiveDueDate_(task) {
  if (!task || !task.deadline) return null;
  var freq = String(task.taskFrequency || task.frequency || '').toLowerCase();
  var today = startOfDay(new Date());
  var d = startOfDay(task.deadline);
  var recurring = ['weekly','biweekly','monthly','quarterly','annual','annually'].indexOf(freq) >= 0;
  if (d >= today || !recurring) return d;
  var guard = 0;
  while (d < today && guard < 600) {
    if (freq === 'weekly') d.setDate(d.getDate() + 7);
    else if (freq === 'biweekly') d.setDate(d.getDate() + 14);
    else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (freq === 'quarterly') d.setMonth(d.getMonth() + 3);
    else d.setFullYear(d.getFullYear() + 1);
    guard++;
  }
  return d;
}
function daysToDue_(task) {
  var eff = effectiveDueDate_(task);
  if (!eff) return null;
  return Math.round((eff - startOfDay(new Date())) / 86400000);
}

function sendWeeklyEmail() {
  var settings = getSettings();
  var recipients = (settings.parentEmails || []).filter(Boolean);
  if (recipients.length === 0) { Logger.log("No parent emails set — skipping."); return; }
  var data = loadData();
  var weekRange = getWeekRange();
  var body = buildEmailBody(data.tasks, settings);
  var subject = "Your calm week ahead — " + formatDateLong(weekRange.start);
  GmailApp.sendEmail(recipients.join(","), subject, body, { name: "The Family Ledger" });
  Logger.log("Sent weekly email to " + recipients.join(", "));
}

function buildEmailBody(allTasks, settings) {
  var names = (settings.parentNames || ["Parent 1", "Parent 2"]).join(" & ");
  var active = (allTasks || []).filter(function (t) { return t.status !== 'completed'; });

  var mustDo = [], comingUp = [], overdueCount = 0;
  active.forEach(function (t) {
    if (isSnoozed(t)) return;
    var d = daysToDue_(t);
    if (t.deadline) {
      if (d !== null && d < 0) { overdueCount++; mustDo.push(t); }
      else if (d !== null && d <= 7) mustDo.push(t);
      else if (d !== null && d <= 30) comingUp.push(t);
    } else {
      var freq = String(t.taskFrequency || t.frequency || '').toLowerCase();
      if (['daily','weekly','biweekly','once','as-needed'].indexOf(freq) >= 0) mustDo.push(t);
    }
  });

  var prio = { high: 0, medium: 1, low: 2 };
  mustDo.sort(function (a, b) {
    var da = daysToDue_(a); var db = daysToDue_(b);
    if (da === null) da = 99; if (db === null) db = 99;
    if (da !== db) return da - db;
    return (prio[a.priority] || 1) - (prio[b.priority] || 1);
  });
  comingUp.sort(function (a, b) { return (daysToDue_(a) || 99) - (daysToDue_(b) || 99); });

  var L = [];
  L.push("Good Sunday morning, " + names + ".");
  L.push("");
  L.push("A calm snapshot — not the whole year, just what matters now.");
  L.push("");
  L.push("== THIS WEEK — must-dos (" + mustDo.length + ") ==");
  if (mustDo.length === 0) L.push("  Nothing pressing. Enjoy the breather.");
  mustDo.slice(0, 12).forEach(function (t) {
    var d = daysToDue_(t);
    var when = (d === null) ? "" : (d < 0 ? " — OVERDUE " + Math.abs(d) + "d" : d === 0 ? " — due today" : " — in " + d + "d");
    var who = t.assignedTo ? " (" + t.assignedTo + ")" : "";
    L.push((t.priority === 'high' ? "* " : "  ") + t.title + when + who);
  });
  if (mustDo.length > 12) L.push("  ...and " + (mustDo.length - 12) + " more this week (open the app).");
  L.push("");

  if (comingUp.length) {
    L.push("== COMING UP — start prepping (next 30 days) ==");
    comingUp.slice(0, 8).forEach(function (t) {
      L.push("  " + t.title + " — in " + daysToDue_(t) + "d" + (t.assignedTo ? " (" + t.assignedTo + ")" : ""));
    });
    L.push("");
  }

  L.push("== BY THE NUMBERS ==");
  L.push("  " + mustDo.length + " to do this week  ·  " + overdueCount + " overdue  ·  " + comingUp.length + " coming up  ·  " + active.length + " tracked total.");
  L.push("");
  L.push("Open the ledger for full category lists and your morning report.");
  return L.join("\n");
}
