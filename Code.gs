/**
 * Бэкенд бронирования столиков для кафе (Google Apps Script).
 *
 * Идея: Google Календарь спокойно хранит несколько событий на одно время.
 * Лимит "N столиков в час" мы контролируем сами: перед созданием брони
 * считаем, сколько событий-броней уже есть в этом часе.
 *
 * API:
 *   GET  ?action=slots&date=YYYY-MM-DD  -> { ok, slots: { "10": 5, "11": 3, ... } }  (свободные столики по часам)
 *   POST { action:"book", date, hour, name, phone, guests } -> { ok } или { ok:false, error }
 */

// ========================= НАСТРОЙКИ =========================
var CONFIG = {
  CALENDAR_ID: 'primary',   // или ID отдельного календаря, напр. 'abc123@group.calendar.google.com'
  TABLES_PER_SLOT: 5,       // столиков доступно в каждый час
  OPEN_HOUR: 10,            // кафе открывается
  CLOSE_HOUR: 22,           // последний слот: 21:00-22:00
  SLOT_MINUTES: 60,         // длительность брони
  EVENT_PREFIX: 'Бронь: '   // по этому префиксу отличаем брони от других событий
};
// =============================================================

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === 'slots') {
      return json_({ ok: true, slots: getSlots_(p.date) });
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

/** Свободные столики по каждому часу на дату date (YYYY-MM-DD). */
function getSlots_(date) {
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) || CalendarApp.getDefaultCalendar();
  var slots = {};
  for (var h = CONFIG.OPEN_HOUR; h < CONFIG.CLOSE_HOUR; h++) {
    var start = parseDate_(date, h);
    var end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);
    var booked = countBookings_(cal, start, end);
    slots[h] = Math.max(0, CONFIG.TABLES_PER_SLOT - booked);
  }
  return slots;
}

/** Создать бронь с проверкой вместимости. Блокировка защищает от гонки двух одновременных броней. */
function book_(data) {
  if (!data.date || data.hour == null || !data.name || !data.phone) {
    return { ok: false, error: 'Заполнены не все поля' };
  }
  var hour = Number(data.hour);
  if (hour < CONFIG.OPEN_HOUR || hour >= CONFIG.CLOSE_HOUR) {
    return { ok: false, error: 'Кафе в это время закрыто' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // ждём до 10 сек, если кто-то бронирует одновременно
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) || CalendarApp.getDefaultCalendar();
    var start = parseDate_(data.date, hour);
    var end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);

    if (start.getTime() < Date.now()) {
      return { ok: false, error: 'Это время уже прошло' };
    }

    var booked = countBookings_(cal, start, end);
    if (booked >= CONFIG.TABLES_PER_SLOT) {
      return { ok: false, error: 'К сожалению, на это время все столики заняты' };
    }

    cal.createEvent(
      CONFIG.EVENT_PREFIX + data.name + ' (' + (data.guests || '?') + ' чел.)',
      start, end,
      { description: 'Телефон: ' + data.phone + '\nГостей: ' + (data.guests || '?') +
                     '\nСтолик №' + (booked + 1) + ' из ' + CONFIG.TABLES_PER_SLOT }
    );
    return { ok: true, tableNumber: booked + 1 };
  } finally {
    lock.releaseLock();
  }
}

/** Сколько броней уже есть в интервале (считаем только события с нашим префиксом). */
function countBookings_(cal, start, end) {
  var events = cal.getEvents(start, end);
  var n = 0;
  for (var i = 0; i < events.length; i++) {
    if (events[i].getTitle().indexOf(CONFIG.EVENT_PREFIX) === 0) n++;
  }
  return n;
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
