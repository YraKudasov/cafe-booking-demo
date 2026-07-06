/**
 * Бэкенд бронирования столиков для кафе (Google Apps Script).
 *
 * Google Календарь хранит каждую бронь отдельным событием. Лимиты по столам
 * контролирует скрипт: в заголовке события метка типа стола [4], по ней
 * считается занятость каждого типа в каждом часе.
 *
 * API:
 *   GET  ?action=slots&date=YYYY-MM-DD&guests=N -> { ok, slots: { "10": 3, ... } }
 *        (сколько подходящих столов свободно в каждый час для N гостей)
 *   POST { action:"book", date, hour, name, phone, guests } -> { ok, seats } или { ok:false, error }
 */

// ========================= НАСТРОЙКИ =========================
var CONFIG = {
  CALENDAR_ID: 'primary',   // или ID отдельного календаря
  // Парк столов кафе: seats — вместимость, count — сколько таких столов
  TABLES: [
    { seats: 2, count: 4 },
    { seats: 4, count: 3 },
    { seats: 6, count: 2 }
  ],
  ALLOW_UPGRADE: true,      // сажать ли компанию за стол побольше, если подходящие кончились
  OPEN_HOUR: 10,            // кафе открывается
  CLOSE_HOUR: 22,           // последний слот: 21:00-22:00
  SLOT_MINUTES: 60,         // длительность брони
  EVENT_PREFIX: 'Бронь ',   // заголовок события: "Бронь [4]: Имя (3 чел.)"
  NOTIFY_EMAIL: ''          // почта для отбивок; пусто = почта владельца скрипта
};
// =============================================================

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === 'slots') {
      return json_({ ok: true, slots: getSlots_(p.date, Number(p.guests) || 1) });
    }
    return json_({ ok: false, error: 'Неизвестное действие' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'book') return json_(book_(data));
    return json_({ ok: false, error: 'Неизвестное действие' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Сколько столов, подходящих для guests гостей, свободно в каждый час даты. */
function getSlots_(date, guests) {
  var cal = getCal_();
  var slots = {};
  for (var h = CONFIG.OPEN_HOUR; h < CONFIG.CLOSE_HOUR; h++) {
    var used = usedByType_(cal, parseDate_(date, h));
    slots[h] = freeSuitable_(used, guests);
  }
  return slots;
}

/** Создать бронь: подбираем минимально подходящий свободный стол. */
function book_(data) {
  if (!data.date || data.hour == null || !data.name || !data.phone) {
    return { ok: false, error: 'Заполнены не все поля' };
  }
  var hour = Number(data.hour);
  var guests = Number(data.guests) || 1;
  if (hour < CONFIG.OPEN_HOUR || hour >= CONFIG.CLOSE_HOUR) {
    return { ok: false, error: 'Кафе в это время закрыто' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cal = getCal_();
    var start = parseDate_(data.date, hour);
    var end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);

    if (start.getTime() < Date.now()) {
      return { ok: false, error: 'Это время уже прошло' };
    }

    var used = usedByType_(cal, start);
    var table = pickTable_(used, guests);
    if (!table) {
      return { ok: false, error: 'К сожалению, на это время нет свободного стола для ' + guests + ' гостей' };
    }

    cal.createEvent(
      CONFIG.EVENT_PREFIX + '[' + table.seats + ']: ' + data.name + ' (' + guests + ' чел.)',
      start, end,
      { description: 'Телефон: ' + data.phone + '\nГостей: ' + guests +
                     '\nСтол: ' + table.seats + '-местный (' + (used[table.seats] + 1) + ' из ' + table.count + ')' }
    );
    notify_(data, hour, guests, table.seats);
    return { ok: true, seats: table.seats };
  } finally {
    lock.releaseLock();
  }
}

/** Занятость по типам столов на конкретный час: { '2': 1, '4': 0, '6': 2 }. */
function usedByType_(cal, start) {
  var end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);
  var events = cal.getEvents(start, end);
  var used = {};
  CONFIG.TABLES.forEach(function (t) { used[t.seats] = 0; });
  for (var i = 0; i < events.length; i++) {
    var m = events[i].getTitle().match(/^Бронь \[(\d+)\]/);
    if (m && used[m[1]] != null) used[m[1]]++;
  }
  return used;
}

/** Сколько столов вместимостью >= guests свободно. */
function freeSuitable_(used, guests) {
  var n = 0;
  CONFIG.TABLES.forEach(function (t) {
    if (t.seats >= guests) n += Math.max(0, t.count - used[t.seats]);
  });
  return n;
}

/** Минимально подходящий свободный стол (или null). */
function pickTable_(used, guests) {
  var sorted = CONFIG.TABLES.slice().sort(function (a, b) { return a.seats - b.seats; });
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    if (t.seats < guests) continue;
    if (used[t.seats] < t.count) return t;
    if (!CONFIG.ALLOW_UPGRADE) break; // без апгрейда пробуем только первый подходящий тип
  }
  return null;
}

/** Письмо-отбивка кафе о новой брони. Ошибка почты не должна ломать бронь. */
function notify_(data, hour, guests, seats) {
  try {
    var to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    var hh = ('0' + hour).slice(-2) + ':00';
    MailApp.sendEmail({
      to: to,
      subject: 'Новая бронь: ' + data.date + ' в ' + hh + ' — ' + data.name,
      body: 'Новая бронь столика!\n\n' +
            'Дата: ' + data.date + '\n' +
            'Время: ' + hh + '\n' +
            'Имя: ' + data.name + '\n' +
            'Телефон: ' + data.phone + '\n' +
            'Гостей: ' + guests + '\n' +
            'Стол: ' + seats + '-местный'
    });
  } catch (e) {
    // ничего: бронь важнее письма
  }
}

function getCal_() {
  return CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) || CalendarApp.getDefaultCalendar();
}

/** 'YYYY-MM-DD' + час -> Date в часовом поясе скрипта. */
function parseDate_(dateStr, hour) {
  var p = dateStr.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hour, 0, 0);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
