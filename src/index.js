export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB) {
      return new Response(SETUP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    try {
      await ensureSchema(env.DB);

      if (url.pathname === "/api/data" && request.method === "GET") {
        return getData(env);
      }

      if (url.pathname === "/api/employees" && request.method === "POST") {
        return addEmployee(request, env);
      }

      if (
        url.pathname.startsWith("/api/employees/") &&
        request.method === "DELETE"
      ) {
        return removeEmployee(url.pathname, env);
      }

      if (url.pathname === "/api/requests" && request.method === "POST") {
        return addRequest(request, env);
      }

      if (
        url.pathname.startsWith("/api/requests/") &&
        request.method === "PUT"
      ) {
        return updateRequest(url.pathname, request, env);
      }

      if (
        url.pathname.startsWith("/api/requests/") &&
        request.method === "DELETE"
      ) {
        return removeRequest(url.pathname, env);
      }

      if (
        url.pathname === "/api/read-sheet" &&
        request.method === "POST"
      ) {
        return readSheet(request, env);
      }

      if (
        url.pathname === "/api/team-calendar" &&
        request.method === "GET"
      ) {
        return getTeamCalendar(env);
      }

      if (
        url.pathname === "/team-calendar" &&
        request.method === "GET"
      ) {
        return new Response(TEAM_CALENDAR_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
          }
        });
      }

      if (url.pathname === "/health") {
        return json({
          ok: true,
          db: true
        });
      }

      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    } catch (err) {
      console.error(err);

      return json(
        {
          error:
            err && err.message
              ? err.message
              : "Unexpected server error"
        },
        500
      );
    }
  }
};

async function ensureSchema(DB) {
  await DB.batch([
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS employees(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        department TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    DB.prepare(`
      CREATE TABLE IF NOT EXISTS time_off_requests(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        employee_name TEXT NOT NULL,
        department TEXT DEFAULT '',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        request_type TEXT DEFAULT 'PTO',
        status TEXT DEFAULT 'Approved',
        day_type TEXT DEFAULT 'Full Day',
        start_time TEXT DEFAULT '',
        end_time TEXT DEFAULT '',
        total_hours REAL,
        notes TEXT DEFAULT '',
        source_filename TEXT DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_timeoff_dates
      ON time_off_requests(start_date,end_date)
    `)
  ]);

  const info = await DB
    .prepare("PRAGMA table_info(time_off_requests)")
    .all();

  const existing = new Set(
    (info.results || []).map(function(row) {
      return row.name;
    })
  );

  const additions = [
    ["day_type", "TEXT DEFAULT 'Full Day'"],
    ["start_time", "TEXT DEFAULT ''"],
    ["end_time", "TEXT DEFAULT ''"],
    ["total_hours", "REAL"]
  ];

  for (const item of additions) {
    if (!existing.has(item[0])) {
      await DB.prepare(
        "ALTER TABLE time_off_requests ADD COLUMN " +
          item[0] +
          " " +
          item[1]
      ).run();
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function clean(value, max = 500) {
  return String(
    value == null
      ? ""
      : value
  )
    .trim()
    .slice(0, max);
}

function getId(pathname) {
  const id = Number(
    pathname
      .split("/")
      .filter(Boolean)
      .pop()
  );

  if (!Number.isInteger(id) || id < 1) {
    throw new Error("Invalid ID");
  }

  return id;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    value || ""
  );
}

async function getData(env) {
  const results = await Promise.all([
    env.DB
      .prepare(
        "SELECT * FROM employees WHERE active=1 ORDER BY name COLLATE NOCASE"
      )
      .all(),

    env.DB
      .prepare(
        "SELECT * FROM time_off_requests ORDER BY start_date ASC, employee_name COLLATE NOCASE"
      )
      .all()
  ]);

  return json({
    employees: results[0].results || [],
    requests: results[1].results || []
  });
}

async function getTeamCalendar(env) {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        employee_name,
        department,
        start_date,
        end_date,
        day_type,
        start_time,
        end_time,
        total_hours
      FROM time_off_requests
      WHERE status='Approved'
      ORDER BY start_date ASC, employee_name COLLATE NOCASE
    `)
    .all();

  return json({
    requests: result.results || []
  });
}

async function addEmployee(request, env) {
  const body = await request.json();

  const name = clean(
    body.name,
    120
  );

  const department = clean(
    body.department,
    120
  );

  if (!name) {
    return json(
      {
        error:
          "Employee name is required."
      },
      400
    );
  }

  await env.DB
    .prepare(
      "INSERT INTO employees(name,department,active) VALUES(?,?,1)"
    )
    .bind(
      name,
      department
    )
    .run();

  return json({
    ok: true
  });
}

async function removeEmployee(
  pathname,
  env
) {
  const id = getId(
    pathname
  );

  await env.DB
    .prepare(
      "UPDATE employees SET active=0 WHERE id=?"
    )
    .bind(id)
    .run();

  return json({
    ok: true
  });
}

function normalizeRequest(body) {
  const employeeId =
    body.employee_id
      ? Number(body.employee_id)
      : null;

  const employeeName = clean(
    body.employee_name,
    120
  );

  const department = clean(
    body.department,
    120
  );

  const startDate = clean(
    body.start_date,
    10
  );

  const endDate = clean(
    body.end_date,
    10
  );

  const requestType = clean(
    body.request_type || "PTO",
    60
  );

  const status = clean(
    body.status || "Approved",
    30
  );

  const dayType = clean(
    body.day_type || "Full Day",
    30
  );

  const startTime = clean(
    body.start_time,
    10
  );

  const endTime = clean(
    body.end_time,
    10
  );

  const totalHours =
    body.total_hours === "" ||
    body.total_hours == null
      ? null
      : Number(body.total_hours);

  const notes = clean(
    body.notes,
    2000
  );

  const sourceFilename = clean(
    body.source_filename,
    255
  );

  if (!employeeName) {
    throw new Error(
      "Employee name is required."
    );
  }

  if (
    !validDate(startDate) ||
    !validDate(endDate)
  ) {
    throw new Error(
      "Valid start and end dates are required."
    );
  }

  if (endDate < startDate) {
    throw new Error(
      "End date cannot be before start date."
    );
  }

  if (
    ![
      "Approved",
      "Pending",
      "Denied"
    ].includes(status)
  ) {
    throw new Error(
      "Invalid status."
    );
  }

  if (
    ![
      "Full Day",
      "Partial Day"
    ].includes(dayType)
  ) {
    throw new Error(
      "Invalid day type."
    );
  }

  if (
    totalHours != null &&
    (
      !Number.isFinite(totalHours) ||
      totalHours < 0 ||
      totalHours > 24
    )
  ) {
    throw new Error(
      "Total hours must be between 0 and 24."
    );
  }

  return {
    employeeId,
    employeeName,
    department,
    startDate,
    endDate,
    requestType,
    status,
    dayType,
    startTime,
    endTime,
    totalHours,
    notes,
    sourceFilename
  };
}

async function addRequest(
  request,
  env
) {
  try {
    const b = normalizeRequest(
      await request.json()
    );

    await env.DB
      .prepare(`
        INSERT INTO time_off_requests(
          employee_id,
          employee_name,
          department,
          start_date,
          end_date,
          request_type,
          status,
          day_type,
          start_time,
          end_time,
          total_hours,
          notes,
          source_filename
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
        b.employeeId,
        b.employeeName,
        b.department,
        b.startDate,
        b.endDate,
        b.requestType,
        b.status,
        b.dayType,
        b.startTime,
        b.endTime,
        b.totalHours,
        b.notes,
        b.sourceFilename
      )
      .run();

    return json({
      ok: true
    });
  } catch (err) {
    return json(
      {
        error: err.message
      },
      400
    );
  }
}

async function updateRequest(
  pathname,
  request,
  env
) {
  try {
    const id = getId(
      pathname
    );

    const b = normalizeRequest(
      await request.json()
    );

    await env.DB
      .prepare(`
        UPDATE time_off_requests
        SET
          employee_id=?,
          employee_name=?,
          department=?,
          start_date=?,
          end_date=?,
          request_type=?,
          status=?,
          day_type=?,
          start_time=?,
          end_time=?,
          total_hours=?,
          notes=?,
          source_filename=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `)
      .bind(
        b.employeeId,
        b.employeeName,
        b.department,
        b.startDate,
        b.endDate,
        b.requestType,
        b.status,
        b.dayType,
        b.startTime,
        b.endTime,
        b.totalHours,
        b.notes,
        b.sourceFilename,
        id
      )
      .run();

    return json({
      ok: true
    });
  } catch (err) {
    return json(
      {
        error: err.message
      },
      400
    );
  }
}

async function removeRequest(
  pathname,
  env
) {
  const id = getId(
    pathname
  );

  await env.DB
    .prepare(
      "DELETE FROM time_off_requests WHERE id=?"
    )
    .bind(id)
    .run();

  return json({
    ok: true
  });
}

async function readSheet(
  request,
  env
) {
  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error:
          "OPENAI_API_KEY is not configured yet."
      },
      500
    );
  }

  const form =
    await request.formData();

  const file =
    form.get("file");

  if (
    !file ||
    typeof file.arrayBuffer !==
      "function"
  ) {
    return json(
      {
        error:
          "Choose a request sheet."
      },
      400
    );
  }

  const allowed =
    new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp"
    ]);

  if (
    !allowed.has(file.type)
  ) {
    return json(
      {
        error:
          "Use PDF, JPG, PNG, or WEBP."
      },
      400
    );
  }

  if (
    file.size >
    10 * 1024 * 1024
  ) {
    return json(
      {
        error:
          "File must be 10 MB or smaller."
      },
      400
    );
  }

  const upload =
    new FormData();

  upload.append(
    "purpose",
    "user_data"
  );

  upload.append(
    "file",
    new Blob(
      [
        await file.arrayBuffer()
      ],
      {
        type: file.type
      }
    ),
    file.name ||
      "time-off-request"
  );

  const uploadResp =
    await fetch(
      "https://api.openai.com/v1/files",
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " +
            env.OPENAI_API_KEY
        },
        body: upload
      }
    );

  const uploadData =
    await uploadResp.json();

  if (
    !uploadResp.ok ||
    !uploadData.id
  ) {
    return json(
      {
        error:
          uploadData &&
          uploadData.error &&
          uploadData.error.message
            ? uploadData.error.message
            : "Unable to upload request sheet."
      },
      502
    );
  }

  const fileId =
    uploadData.id;

  try {
    const today =
      new Date()
        .toISOString()
        .slice(0, 10);

    const prompt =
      "Read this employee time-off request form. Today is " +
      today +
      ".\n\n" +

      "Return ONLY valid JSON with exactly these keys:\n" +

      "{\n" +
      '  "employee_name": "",\n' +
      '  "department": "",\n' +
      '  "start_date": "YYYY-MM-DD",\n' +
      '  "end_date": "YYYY-MM-DD",\n' +
      '  "request_type": "PTO",\n' +
      '  "status": "Approved",\n' +
      '  "day_type": "Full Day",\n' +
      '  "start_time": "",\n' +
      '  "end_time": "",\n' +
      '  "total_hours": null,\n' +
      '  "notes": "",\n' +
      '  "confidence": "High"\n' +
      "}\n\n" +

      "Rules:\n" +
      "- Never invent employee name or dates.\n" +
      "- If only one day is requested, start_date and end_date must be the same.\n" +
      "- request_type should reflect the checked request type.\n" +
      "- status must be Approved, Pending, or Denied.\n" +
      "- day_type must be Full Day or Partial Day.\n" +
      "- For Partial Day, capture start_time and end_time in 24-hour HH:MM format.\n" +
      "- For Partial Day, capture total_hours when visible.\n" +
      "- For Full Day, leave start_time and end_time blank.\n" +
      "- Put actual written comments in notes.\n" +
      "- Do not put the start/end time in notes if it belongs in the timing fields.\n" +
      "- confidence must be High, Medium, or Low.\n" +
      "- Output JSON only.";

    const aiResp =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization:
              "Bearer " +
              env.OPENAI_API_KEY,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              model:
                env.OPENAI_MODEL ||
                "gpt-5-mini",

              store: false,

              input: [
                {
                  role: "user",

                  content: [
                    {
                      type:
                        "input_text",
                      text: prompt
                    },
                    {
                      type:
                        "input_file",
                      file_id:
                        fileId
                    }
                  ]
                }
              ]
            })
        }
      );

    const aiData =
      await aiResp.json();

    if (!aiResp.ok) {
      return json(
        {
          error:
            aiData &&
            aiData.error &&
            aiData.error.message
              ? aiData.error.message
              : "AI could not read this request sheet."
        },
        502
      );
    }

    let outputText = "";

    for (
      const item of
      aiData.output || []
    ) {
      for (
        const part of
        item.content || []
      ) {
        if (
          part.type ===
            "output_text" &&
          part.text
        ) {
          outputText +=
            part.text;
        }
      }
    }

    outputText =
      outputText
        .trim()
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/,
          ""
        )
        .replace(
          /\s*```$/,
          ""
        );

    let extracted;

    try {
      extracted =
        JSON.parse(
          outputText
        );
    } catch (err) {
      return json(
        {
          error:
            "The sheet was read but the returned information could not be parsed."
        },
        502
      );
    }

    extracted.source_filename =
      clean(
        file.name,
        255
      );

    if (
      ![
        "Approved",
        "Pending",
        "Denied"
      ].includes(
        extracted.status
      )
    ) {
      extracted.status =
        "Pending";
    }

    return json({
      ok: true,
      extracted
    });
  } finally {
    try {
      await fetch(
        "https://api.openai.com/v1/files/" +
          fileId,
        {
          method:
            "DELETE",

          headers: {
            Authorization:
              "Bearer " +
              env.OPENAI_API_KEY
          }
        }
      );
    } catch {}
  }
}

const SETUP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PetScript Time Off Setup</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#f4f7fb;
  color:#172033;
  display:grid;
  place-items:center;
  min-height:100vh;
  padding:20px
}
.card{
  max-width:680px;
  background:#fff;
  border:1px solid #e2e7ee;
  border-radius:18px;
  padding:30px
}
.code{
  font-family:monospace;
  background:#edf3fa;
  padding:3px 7px;
  border-radius:7px
}
</style>
</head>
<body>

<div class="card">
<h1>PetScript Time Off</h1>
<p>GitHub deployment is working.</p>
<p>
D1 binding name must be
<span class="code">DB</span>.
</p>
</div>

</body>
</html>`;

const TEAM_CALENDAR_HTML = `<!doctype html>
<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
PetScript Team Time-Off Calendar
</title>

<style>

:root{
  --navy:#0d2138;
  --blue:#347ed8;
  --bg:#f5f7fb;
  --text:#172033;
  --muted:#788397;
  --line:#e5e9f0
}

*{
  box-sizing:border-box
}

body{
  margin:0;
  font-family:Arial,sans-serif;
  background:var(--bg);
  color:var(--text)
}

header{
  background:var(--navy);
  color:#fff;
  padding:22px 28px
}

header h1{
  margin:0;
  font-size:23px
}

header p{
  margin:5px 0 0;
  font-size:12px;
  opacity:.7
}

main{
  max-width:1300px;
  margin:0 auto;
  padding:24px
}

.toolbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:12px;
  margin-bottom:15px
}

.title{
  font-size:20px;
  font-weight:800
}

.nav{
  display:flex;
  gap:7px
}

button{
  border:0;
  border-radius:9px;
  padding:9px 12px;
  background:#e9eef5;
  color:var(--text);
  font-weight:700;
  cursor:pointer
}

.calendarWrap{
  overflow:auto
}

.calendar{
  display:grid;
  grid-template-columns:
    repeat(7,1fr);

  min-width:850px;
  border-left:
    1px solid var(--line);

  border-top:
    1px solid var(--line);

  border-radius:13px;
  overflow:hidden;
  background:white
}

.dow{
  padding:10px;
  text-align:center;
  font-size:11px;
  font-weight:800;
  color:var(--muted);
  background:#f7f9fc;
  border-right:
    1px solid var(--line);
  border-bottom:
    1px solid var(--line)
}

.day{
  min-height:125px;
  padding:8px;
  border-right:
    1px solid var(--line);
  border-bottom:
    1px solid var(--line);
  background:#fff
}

.day.other{
  background:#fafbfc;
  color:#aeb6c1
}

.day.today{
  box-shadow:
    inset 0 0 0 2px
    var(--blue)
}

.daynum{
  font-size:12px;
  font-weight:800;
  margin-bottom:6px
}

.event{
  font-size:11px;
  font-weight:800;
  background:#eaf2fd;
  color:#245d9d;
  border-radius:7px;
  padding:6px 7px;
  margin-top:4px;
  overflow:hidden
}

.eventTime{
  font-size:9px;
  font-weight:600;
  margin-top:3px
}

.legend{
  margin-top:14px;
  font-size:12px;
  color:var(--muted)
}

@media(max-width:700px){

  header{
    padding:18px
  }

  main{
    padding:14px
  }

  .toolbar{
    align-items:flex-start;
    flex-direction:column
  }
}

</style>

</head>

<body>

<header>

<h1>
PetScript Team Time-Off Calendar
</h1>

<p>
Approved time off · Read only
</p>

</header>

<main>

<div class="toolbar">

<div
  class="title"
  id="monthTitle"
></div>

<div class="nav">

<button onclick="moveMonth(-1)">
←
</button>

<button onclick="cursor=new Date();render()">
Today
</button>

<button onclick="moveMonth(1)">
→
</button>

</div>

</div>

<div class="calendarWrap">

<div
  id="calendar"
  class="calendar"
></div>

</div>

<div class="legend">
Team view shows only approved time off and timing.
</div>

</main>

<script>

var requests = [];

var cursor =
  new Date();

document.addEventListener(
  "DOMContentLoaded",
  async function() {

    try {

      var response =
        await fetch(
          "/api/team-calendar"
        );

      var data =
        await response.json();

      requests =
        data.requests || [];

      render();

    } catch (err) {

      document.getElementById(
        "calendar"
      ).innerHTML =
        '<div style="padding:20px">Unable to load calendar.</div>';

    }

  }
);

function localISO(date) {

  return [
    date.getFullYear(),

    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    ),

    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    )
  ].join("-");

}

function esc(value) {

  return String(
    value == null
      ? ""
      : value
  ).replace(
    /[&<>"']/g,
    function(ch) {

      return {
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#039;"
      }[ch];

    }
  );

}

function overlaps(
  row,
  date
) {

  return (
    row.start_date <= date &&
    row.end_date >= date
  );

}

function formatTime(value) {

  if (!value) {
    return "";
  }

  var parts =
    String(value)
      .split(":");

  var h =
    Number(
      parts[0]
    );

  var m =
    Number(
      parts[1] || 0
    );

  if (
    !Number.isFinite(h)
  ) {
    return value;
  }

  var suffix =
    h >= 12
      ? "PM"
      : "AM";

  var hour =
    h % 12 || 12;

  return (
    hour +
    ":" +
    String(m).padStart(
      2,
      "0"
    ) +
    " " +
    suffix
  );

}

function durationText(row) {

  if (
    row.day_type ===
    "Partial Day"
  ) {

    var range = "";

    if (
      row.start_time &&
      row.end_time
    ) {

      range =
        formatTime(
          row.start_time
        ) +
        "–" +
        formatTime(
          row.end_time
        );

    }

    var hrs =
      row.total_hours != null &&
      row.total_hours !== ""
        ? String(
            row.total_hours
          ) +
          (
            Number(
              row.total_hours
            ) === 1
              ? " hr"
              : " hrs"
          )
        : "";

    return [
      range,
      hrs
    ]
      .filter(Boolean)
      .join(" · ") ||
      "PARTIAL DAY";

  }

  return "FULL DAY";

}

function render() {

  var year =
    cursor.getFullYear();

  var month =
    cursor.getMonth();

  var first =
    new Date(
      year,
      month,
      1
    );

  var last =
    new Date(
      year,
      month + 1,
      0
    );

  document.getElementById(
    "monthTitle"
  ).textContent =
    new Intl.DateTimeFormat(
      "en-US",
      {
        month:"long",
        year:"numeric"
      }
    ).format(first);

  var start =
    new Date(first);

  start.setDate(
    1 -
    first.getDay()
  );

  var end =
    new Date(last);

  end.setDate(
    last.getDate() +
    (
      6 -
      last.getDay()
    )
  );

  var today =
    localISO(
      new Date()
    );

  var html =
    [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat"
    ]
      .map(
        function(day) {

          return (
            '<div class="dow">' +
            day +
            "</div>"
          );

        }
      )
      .join("");

  var d =
    new Date(start);

  while (
    d <= end
  ) {

    var ds =
      localISO(d);

    var rows =
      requests.filter(
        function(row) {

          return overlaps(
            row,
            ds
          );

        }
      );

    html +=
      '<div class="day ' +

      (
        d.getMonth() !==
        month
          ? "other "
          : ""
      ) +

      (
        ds === today
          ? "today"
          : ""
      ) +

      '">' +

      '<div class="daynum">' +

      d.getDate() +

      "</div>";

    rows.forEach(
      function(row) {

        html +=
          '<div class="event">' +

          esc(
            row.employee_name
          ) +

          '<div class="eventTime">' +

          esc(
            durationText(row)
          ) +

          "</div>" +

          "</div>";

      }
    );

    html +=
      "</div>";

    d.setDate(
      d.getDate() + 1
    );

  }

  document.getElementById(
    "calendar"
  ).innerHTML =
    html;

}

function moveMonth(amount) {

  cursor =
    new Date(
      cursor.getFullYear(),
      cursor.getMonth() +
      amount,
      1
    );

  render();

}

</script>

</body>

</html>`;

const APP_HTML = `<!doctype html>

<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
PetScript Time Off
</title>

<style>

:root{
  --navy:#0d2138;
  --blue:#347ed8;
  --bg:#f5f7fb;
  --text:#172033;
  --muted:#788397;
  --line:#e5e9f0;
  --green:#147451;
  --red:#aa3346;
  --amber:#936814
}

*{
  box-sizing:border-box
}

body{
  margin:0;
  font-family:Arial,sans-serif;
  background:var(--bg);
  color:var(--text)
}

button,
input,
select,
textarea{
  font:inherit
}

button{
  cursor:pointer
}

.app{
  min-height:100vh;
  display:grid;
  grid-template-columns:
    245px 1fr
}

aside{
  background:var(--navy);
  color:#fff;
  padding:24px 16px;
  display:flex;
  flex-direction:column;
  position:sticky;
  top:0;
  height:100vh
}

.brand{
  display:flex;
  gap:11px;
  align-items:center;
  padding:4px 8px 25px
}

.logo{
  width:42px;
  height:42px;
  background:white;
  color:var(--navy);
  border-radius:12px;
  display:grid;
  place-items:center;
  font-weight:900
}

.brand strong,
.brand span{
  display:block
}

.brand span{
  font-size:11px;
  opacity:.6;
  margin-top:3px
}

nav{
  display:grid;
  gap:5px
}

nav button{
  border:0;
  background:transparent;
  color:#dce6f1;
  text-align:left;
  padding:12px;
  border-radius:10px;
  font-weight:700
}

nav button:hover,
nav button.active{
  background:
    rgba(
      255,
      255,
      255,
      .11
    );

  color:white
}

.foot{
  margin-top:auto;
  font-size:11px;
  opacity:.45;
  padding:8px
}

main{
  min-width:0;
  padding:30px 35px 60px
}

.top{
  display:flex;
  justify-content:
    space-between;
  align-items:center;
  gap:20px;
  margin-bottom:24px
}

.eyebrow{
  font-size:10px;
  letter-spacing:.14em;
  color:var(--blue);
  font-weight:900
}

h1{
  font-size:27px;
  margin:4px 0 0
}

h2{
  font-size:17px;
  margin:0
}

.today{
  font-size:12px;
  color:var(--muted);
  font-weight:600;
  margin-top:5px
}

.btn{
  border:0;
  border-radius:10px;
  padding:10px 14px;
  background:#edf2f7;
  color:var(--text);
  font-weight:750
}

.btn.primary{
  background:var(--navy);
  color:white
}

.btn.danger{
  background:#feecef;
  color:var(--red)
}

.btn:disabled{
  opacity:.55
}

.view{
  display:none
}

.view.active{
  display:block
}

.stats{
  display:grid;
  grid-template-columns:
    repeat(4,1fr);
  gap:14px;
  margin-bottom:18px
}

.stat,
.card{
  background:white;
  border:
    1px solid var(--line);
  border-radius:15px
}

.stat{
  padding:18px
}

.stat.dark{
  background:var(--navy);
  color:white
}

.stat label{
  font-size:10px;
  letter-spacing:.12em;
  font-weight:900;
  opacity:.65;
  display:block
}

.stat strong{
  font-size:35px;
  display:block;
  margin:5px 0
}

.stat small{
  opacity:.65
}

.grid2{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:18px
}

.card{
  padding:20px;
  margin-bottom:18px
}

.head{
  display:flex;
  justify-content:
    space-between;
  align-items:center;
  gap:12px;
  margin-bottom:13px
}

.sub{
  font-size:11px;
  color:var(--muted);
  margin-top:4px
}

.person{
  display:flex;
  gap:11px;
  align-items:center;
  padding:11px 0;
  border-top:
    1px solid var(--line)
}

.person:first-child{
  border-top:0
}

.avatar{
  width:38px;
  height:38px;
  border-radius:11px;
  background:#eaf2fd;
  color:#286ab8;
  display:grid;
  place-items:center;
  font-weight:900
}

.grow{
  flex:1
}

.grow strong,
.grow span{
  display:block
}

.grow span{
  font-size:11px;
  color:var(--muted);
  margin-top:3px
}

.empty{
  text-align:center;
  padding:32px 10px;
  color:var(--muted)
}

.empty strong{
  display:block;
  color:var(--text);
  margin-bottom:5px
}

table{
  width:100%;
  border-collapse:
    collapse;
  font-size:12px
}

th{
  text-align:left;
  padding:9px;
  color:var(--muted);
  font-size:10px;
  letter-spacing:.08em;
  border-bottom:
    1px solid var(--line)
}

td{
  padding:10px 9px;
  border-bottom:
    1px solid var(--line)
}

.table{
  overflow:auto
}

.status{
  border-radius:999px;
  padding:4px 8px;
  font-size:10px;
  font-weight:850
}

.Approved{
  background:#e7f6ef;
  color:var(--green)
}

.Pending{
  background:#fff4d7;
  color:var(--amber)
}

.Denied{
  background:#fde9ec;
  color:var(--red)
}

.form{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:12px
}

.form label{
  font-size:11px;
  font-weight:750;
  color:#596476
}

.form input,
.form select,
.form textarea{
  width:100%;
  display:block;
  margin-top:5px;
  border:
    1px solid #dfe5ec;
  border-radius:9px;
  padding:10px;
  background:white;
  color:var(--text)
}

.form textarea{
  min-height:80px
}

.span2{
  grid-column:span 2
}

.upload{
  display:block;
  border:
    2px dashed #ccd5df;
  border-radius:15px;
  text-align:center;
  padding:34px;
  background:#fafcff
}

.upload input{
  display:none
}

.upicon{
  width:52px;
  height:52px;
  border-radius:15px;
  background:#eaf2fd;
  color:var(--blue);
  display:grid;
  place-items:center;
  margin:0 auto 12px;
  font-size:24px;
  font-weight:900
}

.upload p{
  font-size:12px;
  color:var(--muted)
}

.chosen{
  font-size:12px;
  font-weight:800;
  color:var(--blue);
  margin-top:8px
}

.notice{
  padding:11px 13px;
  border-radius:10px;
  background:#eaf2fd;
  color:#255e9b;
  font-size:12px;
  margin-bottom:15px
}

.notice.bad{
  background:#feecef;
  color:#962f40
}

.calbar{
  display:flex;
  justify-content:
    space-between;
  align-items:center;
  margin-bottom:13px
}

.calnav{
  display:flex;
  gap:7px
}

.calendarWrap{
  overflow:auto
}

.calendar{
  display:grid;
  grid-template-columns:
    repeat(7,1fr);
  min-width:760px;
  border-left:
    1px solid var(--line);
  border-top:
    1px solid var(--line);
  border-radius:12px;
  overflow:hidden
}

.dow{
  padding:9px;
  text-align:center;
  background:#f7f9fc;
  color:var(--muted);
  font-size:10px;
  font-weight:900;
  border-right:
    1px solid var(--line);
  border-bottom:
    1px solid var(--line)
}

.day{
  min-height:112px;
  background:white;
  padding:7px;
  border-right:
    1px solid var(--line);
  border-bottom:
    1px solid var(--line)
}

.day.other{
  background:#fafbfc;
  color:#aeb6c1
}

.day.current{
  box-shadow:
    inset 0 0 0 2px
    var(--blue)
}

.daynum{
  font-size:11px;
  font-weight:850
}

.event{
  font-size:9px;
  font-weight:800;
  background:#eaf2fd;
  color:#245d9d;
  border-radius:6px;
  padding:4px 5px;
  margin-top:4px;
  overflow:hidden
}

.modal{
  position:fixed;
  inset:0;
  background:
    rgba(
      8,
      20,
      34,
      .54
    );
  display:none;
  align-items:center;
  justify-content:center;
  padding:18px;
  z-index:20
}

.modal.show{
  display:flex
}

.modalCard{
  background:white;
  border-radius:17px;
  padding:22px;
  width:min(
    650px,
    100%
  );
  max-height:92vh;
  overflow:auto
}

.modalHead{
  display:flex;
  justify-content:
    space-between;
  align-items:flex-start;
  margin-bottom:15px
}

.x{
  background:none;
  border:0;
  font-size:25px;
  color:var(--muted)
}

.actions{
  display:flex;
  justify-content:flex-end;
  gap:8px;
  margin-top:14px
}

@media(max-width:950px){

  .app{
    grid-template-columns:1fr
  }

  aside{
    height:auto;
    position:relative
  }

  nav{
    grid-template-columns:
      repeat(3,1fr)
  }

  .foot{
    display:none
  }

  main{
    padding:20px
  }

  .stats{
    grid-template-columns:
      1fr 1fr
  }

  .grid2{
    grid-template-columns:1fr
  }
}

@media(max-width:600px){

  nav{
    grid-template-columns:
      1fr 1fr
  }

  .top{
    flex-direction:column;
    align-items:flex-start
  }

  .form{
    grid-template-columns:1fr
  }

  .span2{
    grid-column:span 1
  }

  .card{
    padding:15px
  }

  main{
    padding:15px
  }

  .stat strong{
    font-size:29px
  }
}

</style>

</head>

<body>

<div class="app">

<aside>

<div class="brand">

<div class="logo">
PS
</div>

<div>
<strong>
PetScript
</strong>
<span>
Time Off Admin
</span>
</div>

</div>

<nav>

<button
  data-view="dashboard"
  class="active"
>
Dashboard
</button>

<button data-view="week">
This Week
</button>

<button data-view="month">
This Month
</button>

<button data-view="calendar">
Calendar
</button>

<button data-view="employees">
Employees
</button>

<button data-view="upload">
Upload Request
</button>

<button data-view="uploads">
Uploaded Requests
</button>

</nav>

<div class="foot">
Internal employee scheduling
</div>

</aside>

<main>

<div class="top">

<div>

<div class="eyebrow">
EMPLOYEE LEAVE
</div>

<h1 id="title">
Time Off Dashboard
</h1>

<div
  class="today"
  id="todayLabel"
></div>

</div>

<button
  class="btn primary"
  onclick="showView('upload')"
>
＋ Upload request sheet
</button>

</div>

<div id="message"></div>

<section
  id="dashboard"
  class="view active"
></section>

<section
  id="week"
  class="view"
></section>

<section
  id="month"
  class="view"
></section>

<section
  id="calendar"
  class="view"
></section>

<section
  id="employees"
  class="view"
></section>

<section
  id="upload"
  class="view"
></section>

<section
  id="uploads"
  class="view"
></section>

</main>

</div>

<div
  id="modal"
  class="modal"
>

<div class="modalCard">

<div class="modalHead">

<div>

<div
  class="eyebrow"
  id="modalEyebrow"
>
TIME OFF
</div>

<h2 id="modalTitle">
Request
</h2>

</div>

<button
  class="x"
  type="button"
  onclick="closeModal()"
>
×
</button>

</div>

<form
  id="requestForm"
  class="form"
>

<input
  type="hidden"
  id="reqId"
>

<label class="span2">
Match employee

<select
  id="employeeSelect"
></select>

</label>

<label class="span2">
Employee name

<input
  id="employeeName"
  required
>

</label>

<label>
Department

<input
  id="department"
>

</label>

<label>
Type

<select
  id="requestType"
>

<option>PTO</option>
<option>Vacation</option>
<option>Sick</option>
<option>Personal</option>
<option>Unpaid</option>
<option>Bereavement</option>
<option>Time Off</option>

</select>

</label>

<label>
Start date

<input
  type="date"
  id="startDate"
  required
>

</label>

<label>
End date

<input
  type="date"
  id="endDate"
  required
>

</label>

<label>
Day type

<select id="dayType">

<option>
Full Day
</option>

<option>
Partial Day
</option>

</select>

</label>

<label>
Total hours

<input
  id="totalHours"
  type="number"
  min="0"
  max="24"
  step="0.25"
  placeholder="1"
>

</label>

<label>
Start time

<input
  type="time"
  id="startTime"
>

</label>

<label>
End time

<input
  type="time"
  id="endTime"
>

</label>

<label>
Status

<select id="status">

<option>Approved</option>
<option>Pending</option>
<option>Denied</option>

</select>

</label>

<label class="span2">
Notes

<textarea
  id="notes"
></textarea>

</label>

<input
  type="hidden"
  id="sourceFilename"
>

<div class="span2 actions">

<button
  class="btn"
  type="button"
  onclick="closeModal()"
>
Cancel
</button>

<button
  class="btn primary"
>
Save to calendar
</button>

</div>

</form>

</div>

</div>

<script>

var state = {
  employees: [],
  requests: []
};

var currentView =
  "dashboard";

var calendarCursor =
  new Date();

var titles = {
  dashboard:
    "Time Off Dashboard",

  week:
    "This Week",

  month:
    "This Month",

  calendar:
    "Team Calendar",

  employees:
    "Employee Directory",

  upload:
    "Upload Time-Off Request",

  uploads:
    "Uploaded Requests"
};

document.addEventListener(
  "DOMContentLoaded",
  function() {

    document.getElementById(
      "todayLabel"
    ).textContent =
      new Intl.DateTimeFormat(
        "en-US",
        {
          weekday:"long",
          month:"long",
          day:"numeric",
          year:"numeric"
        }
      ).format(
        new Date()
      );

    document.querySelectorAll(
      "nav button"
    ).forEach(
      function(btn) {

        btn.addEventListener(
          "click",
          function() {

            showView(
              btn.getAttribute(
                "data-view"
              )
            );

          }
        );

      }
    );

    document.getElementById(
      "requestForm"
    ).addEventListener(
      "submit",
      saveRequest
    );

    reload();

  }
);

async function api(
  url,
  options
) {

  options =
    options || {};

  var headers =
    options.headers || {};

  if (
    options.body &&
    !(
      options.body instanceof
      FormData
    )
  ) {

    headers[
      "content-type"
    ] =
      "application/json";

  }

  var response =
    await fetch(
      url,
      Object.assign(
        {},
        options,
        {
          headers:headers
        }
      )
    );

  var data;

  try {

    data =
      await response.json();

  } catch {

    data = {};

  }

  if (
    !response.ok
  ) {

    throw new Error(
      data.error ||
      "Request failed."
    );

  }

  return data;

}

async function reload() {

  try {

    state =
      await api(
        "/api/data"
      );

    renderAll();

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  }

}

function showMessage(
  text,
  bad
) {

  var el =
    document.getElementById(
      "message"
    );

  if (!text) {

    el.innerHTML = "";

    return;

  }

  el.innerHTML =
    '<div class="notice ' +
    (
      bad
        ? "bad"
        : ""
    ) +
    '">' +
    escapeHtml(text) +
    "</div>";

  setTimeout(
    function() {

      el.innerHTML = "";

    },
    5000
  );

}

function showView(name) {

  currentView =
    name;

  document.querySelectorAll(
    ".view"
  ).forEach(
    function(el) {

      el.classList.toggle(
        "active",
        el.id === name
      );

    }
  );

  document.querySelectorAll(
    "nav button"
  ).forEach(
    function(btn) {

      btn.classList.toggle(
        "active",
        btn.getAttribute(
          "data-view"
        ) === name
      );

    }
  );

  document.getElementById(
    "title"
  ).textContent =
    titles[name] ||
    "PetScript Time Off";

  if (
    name ===
    "calendar"
  ) {

    renderCalendar();

  }

}

function escapeHtml(value) {

  return String(
    value == null
      ? ""
      : value
  ).replace(
    /[&<>"']/g,
    function(ch) {

      return {
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#039;"
      }[ch];

    }
  );

}

function localISO(date) {

  return [
    date.getFullYear(),

    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    ),

    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    )
  ].join("-");

}

function parseDate(value) {

  var parts =
    value
      .split("-")
      .map(Number);

  return new Date(
    parts[0],
    parts[1] - 1,
    parts[2]
  );

}

function fmtDate(value) {

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month:"short",
      day:"numeric"
    }
  ).format(
    parseDate(value)
  );

}

function initials(name) {

  return String(
    name || "?"
  )
    .split(/\s+/)
    .slice(0,2)
    .map(
      function(part) {

        return part.charAt(0);

      }
    )
    .join("")
    .toUpperCase();

}

function overlaps(
  row,
  start,
  end
) {

  return (
    row.status !==
      "Denied" &&

    row.start_date <=
      end &&

    row.end_date >=
      start
  );

}

function periodInfo() {

  var now =
    new Date();

  var today =
    localISO(now);

  var weekStart =
    new Date(now);

  weekStart.setDate(
    now.getDate() -
    (
      (
        now.getDay() + 6
      ) % 7
    )
  );

  var weekEnd =
    new Date(
      weekStart
    );

  weekEnd.setDate(
    weekStart.getDate() +
    6
  );

  var monthStart =
    new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

  var monthEnd =
    new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0
    );

  return {
    today:today,

    weekStart:
      localISO(
        weekStart
      ),

    weekEnd:
      localISO(
        weekEnd
      ),

    monthStart:
      localISO(
        monthStart
      ),

    monthEnd:
      localISO(
        monthEnd
      )
  };

}

function uniqueCount(rows) {

  return new Set(
    rows.map(
      function(row) {

        return row.employee_name
          .toLowerCase();

      }
    )
  ).size;

}

function dateRange(row) {

  if (
    row.start_date ===
    row.end_date
  ) {

    return fmtDate(
      row.start_date
    );

  }

  return (
    fmtDate(
      row.start_date
    ) +
    " – " +
    fmtDate(
      row.end_date
    )
  );

}

function formatTime(value) {

  if (!value) {
    return "";
  }

  var parts =
    String(value)
      .split(":");

  var h =
    Number(
      parts[0]
    );

  var m =
    Number(
      parts[1] || 0
    );

  if (
    !Number.isFinite(h)
  ) {

    return value;

  }

  var suffix =
    h >= 12
      ? "PM"
      : "AM";

  var hour =
    h % 12 || 12;

  return (
    hour +
    ":" +
    String(m)
      .padStart(
        2,
        "0"
      ) +
    " " +
    suffix
  );

}

function durationText(row) {

  if (
    row.day_type ===
    "Partial Day"
  ) {

    var range =
      row.start_time &&
      row.end_time

        ? (
            formatTime(
              row.start_time
            ) +
            "–" +
            formatTime(
              row.end_time
            )
          )

        : "PARTIAL DAY";

    var hrs =
      row.total_hours != null &&
      row.total_hours !== ""

        ? (
            String(
              row.total_hours
            ) +
            (
              Number(
                row.total_hours
              ) === 1

                ? " hr"

                : " hrs"
            )
          )

        : "";

    return [
      range,
      hrs
    ]
      .filter(Boolean)
      .join(" · ");

  }

  return "FULL DAY";

}

function personRow(
  name,
  subtitle,
  rightHtml
) {

  return (
    '<div class="person">' +

    '<div class="avatar">' +
    escapeHtml(
      initials(name)
    ) +
    "</div>" +

    '<div class="grow">' +

    "<strong>" +
    escapeHtml(name) +
    "</strong>" +

    "<span>" +
    escapeHtml(
      subtitle || ""
    ) +
    "</span>" +

    "</div>" +

    (
      rightHtml || ""
    ) +

    "</div>"
  );

}

function requestTable(rows) {

  if (!rows.length) {

    return (
      '<div class="empty">' +
      "<strong>No requests yet.</strong>" +
      "</div>"
    );

  }

  var html =
    '<div class="table">' +

    "<table>" +

    "<thead>" +

    "<tr>" +

    "<th>Employee</th>" +

    "<th>Dates</th>" +

    "<th>Hours</th>" +

    "<th>Type</th>" +

    "<th>Status</th>" +

    "<th></th>" +

    "</tr>" +

    "</thead>" +

    "<tbody>";

  rows.forEach(
    function(row) {

      html +=
        "<tr>" +

        "<td>" +

        "<strong>" +
        escapeHtml(
          row.employee_name
        ) +
        "</strong>" +

        '<div class="sub">' +
        escapeHtml(
          row.department || ""
        ) +
        "</div>" +

        "</td>" +

        "<td>" +
        escapeHtml(
          dateRange(row)
        ) +
        "</td>" +

        "<td>" +
        escapeHtml(
          durationText(row)
        ) +
        "</td>" +

        "<td>" +
        escapeHtml(
          row.request_type
        ) +
        "</td>" +

        "<td>" +

        '<span class="status ' +
        escapeHtml(
          row.status
        ) +
        '">' +

        escapeHtml(
          row.status
        ) +

        "</span>" +

        "</td>" +

        "<td>" +

        '<button class="btn" onclick="editRequest(' +
        row.id +
        ')">Edit</button> ' +

        '<button class="btn danger" onclick="deleteRequest(' +
        row.id +
        ')">Delete</button>' +

        "</td>" +

        "</tr>";

    }
  );

  html +=
    "</tbody>" +
    "</table>" +
    "</div>";

  return html;

}

function renderAll() {

  renderDashboard();

  renderWeek();

  renderMonth();

  renderEmployees();

  renderUpload();

  renderUploadsLog();

  renderCalendar();

}

function renderDashboard() {

  var p =
    periodInfo();

  var todayRows =
    state.requests.filter(
      function(row) {

        return overlaps(
          row,
          p.today,
          p.today
        );

      }
    );

  var weekRows =
    state.requests.filter(
      function(row) {

        return overlaps(
          row,
          p.weekStart,
          p.weekEnd
        );

      }
    );

  var monthRows =
    state.requests.filter(
      function(row) {

        return overlaps(
          row,
          p.monthStart,
          p.monthEnd
        );

      }
    );

  var offToday =
    new Set(
      todayRows
        .filter(
          function(row) {

            return (
              row.status ===
              "Approved"
            );

          }
        )
        .map(
          function(row) {

            return (
              row.employee_name
                .toLowerCase()
            );

          }
        )
    );

  var working =
    state.employees.filter(
      function(emp) {

        return !offToday.has(
          emp.name
            .toLowerCase()
        );

      }
    );

  var upcoming =
    state.requests
      .filter(
        function(row) {

          return (
            row.end_date >=
              p.today &&
            row.status !==
              "Denied"
          );

        }
      )
      .slice(
        0,
        12
      );

  var todayHtml =
    todayRows.length

      ? todayRows
          .map(
            function(row) {

              return personRow(
                row.employee_name,

                (
                  row.department ||
                  "No department"
                ) +
                " · " +
                row.request_type +
                " · " +
                durationText(row),

                '<span class="status ' +
                escapeHtml(
                  row.status
                ) +
                '">' +
                escapeHtml(
                  row.status
                ) +
                "</span>"
              );

            }
          )
          .join("")

      : (
          '<div class="empty">' +
          "<strong>No one is off today.</strong>" +
          "</div>"
        );

  var workingHtml =
    working.length

      ? working
          .map(
            function(emp) {

              return personRow(
                emp.name,

                emp.department ||
                "No department",

                ""
              );

            }
          )
          .join("")

      : (
          '<div class="empty">' +
          "<strong>No employees in the roster.</strong>" +
          "</div>"
        );

  document.getElementById(
    "dashboard"
  ).innerHTML =

    '<div class="stats">' +

    '<div class="stat dark">' +

    "<label>OFF TODAY</label>" +

    "<strong>" +
    uniqueCount(
      todayRows
    ) +
    "</strong>" +

    "<small>" +
    fmtDate(
      p.today
    ) +
    "</small>" +

    "</div>" +

    '<div class="stat">' +

    "<label>WORKING TODAY</label>" +

    "<strong>" +
    working.length +
    "</strong>" +

    "<small>Active roster minus approved leave</small>" +

    "</div>" +

    '<div class="stat">' +

    "<label>THIS WEEK</label>" +

    "<strong>" +
    uniqueCount(
      weekRows
    ) +
    "</strong>" +

    "<small>" +

    fmtDate(
      p.weekStart
    ) +

    " – " +

    fmtDate(
      p.weekEnd
    ) +

    "</small>" +

    "</div>" +

    '<div class="stat">' +

    "<label>THIS MONTH</label>" +

    "<strong>" +
    uniqueCount(
      monthRows
    ) +
    "</strong>" +

    "<small>Current month</small>" +

    "</div>" +

    "</div>" +

    '<div class="grid2">' +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">TODAY</div>' +

    "<h2>Who is off</h2>" +

    "</div>" +

    "</div>" +

    todayHtml +

    "</div>" +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">TODAY</div>' +

    "<h2>Who is working</h2>" +

    "</div>" +

    "</div>" +

    workingHtml +

    "</div>" +

    "</div>" +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">UPCOMING</div>' +

    "<h2>Upcoming requests</h2>" +

    "</div>" +

    '<button class="btn" onclick="newRequest()">＋ Manual request</button>' +

    "</div>" +

    requestTable(
      upcoming
    ) +

    "</div>";

}

function renderWeek() {

  var p =
    periodInfo();

  var date =
    parseDate(
      p.weekStart
    );

  var html =
    '<div class="grid2">';

  for (
    var i = 0;
    i < 7;
    i++
  ) {

    var dateString =
      localISO(date);

    var rows =
      state.requests.filter(
        function(row) {

          return overlaps(
            row,
            dateString,
            dateString
          );

        }
      );

    var content =
      rows.length

        ? rows
            .map(
              function(row) {

                return personRow(
                  row.employee_name,

                  (
                    row.department ||
                    ""
                  ) +
                  " · " +
                  durationText(row),

                  '<span class="status ' +
                  escapeHtml(
                    row.status
                  ) +
                  '">' +
                  escapeHtml(
                    row.status
                  ) +
                  "</span>"
                );

              }
            )
            .join("")

        : (
            '<div class="empty">' +
            "<strong>No one scheduled off.</strong>" +
            "</div>"
          );

    html +=
      '<div class="card">' +

      '<div class="head">' +

      "<div>" +

      '<div class="eyebrow">' +

      new Intl.DateTimeFormat(
        "en-US",
        {
          weekday:"long"
        }
      )
        .format(date)
        .toUpperCase() +

      "</div>" +

      "<h2>" +
      fmtDate(
        dateString
      ) +
      "</h2>" +

      "</div>" +

      "</div>" +

      content +

      "</div>";

    date.setDate(
      date.getDate() + 1
    );

  }

  html +=
    "</div>";

  document.getElementById(
    "week"
  ).innerHTML =
    html;

}

function renderMonth() {

  var p =
    periodInfo();

  var rows =
    state.requests.filter(
      function(row) {

        return overlaps(
          row,
          p.monthStart,
          p.monthEnd
        );

      }
    );

  document.getElementById(
    "month"
  ).innerHTML =

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">CURRENT MONTH</div>' +

    "<h2>Monthly leave</h2>" +

    "</div>" +

    '<button class="btn primary" onclick="newRequest()">＋ Add request</button>' +

    "</div>" +

    requestTable(
      rows
    ) +

    "</div>";

}

function renderEmployees() {

  var employeeHtml =
    state.employees.length

      ? state.employees
          .map(
            function(emp) {

              return personRow(
                emp.name,

                emp.department ||
                "No department",

                '<button class="btn danger" onclick="removeEmployee(' +
                emp.id +
                ')">Remove</button>'
              );

            }
          )
          .join("")

      : (
          '<div class="empty">' +
          "<strong>No employees yet.</strong>" +
          "</div>"
        );

  document.getElementById(
    "employees"
  ).innerHTML =

    '<div class="grid2">' +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">ROSTER</div>' +

    "<h2>Active employees</h2>" +

    '<div class="sub">Used to calculate who is working today.</div>' +

    "</div>" +

    "</div>" +

    employeeHtml +

    "</div>" +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">ADD EMPLOYEE</div>' +

    "<h2>Employee directory</h2>" +

    "</div>" +

    "</div>" +

    '<form id="employeeForm" class="form">' +

    '<label class="span2">' +

    "Name" +

    '<input id="newEmployeeName" required>' +

    "</label>" +

    '<label class="span2">' +

    "Department" +

    '<input id="newEmployeeDepartment">' +

    "</label>" +

    '<div class="span2">' +

    '<button class="btn primary">Add employee</button>' +

    "</div>" +

    "</form>" +

    "</div>" +

    "</div>";

  document.getElementById(
    "employeeForm"
  ).addEventListener(
    "submit",
    addEmployee
  );

}

async function addEmployee(event) {

  event.preventDefault();

  try {

    await api(
      "/api/employees",
      {
        method:"POST",

        body:
          JSON.stringify({
            name:
              document.getElementById(
                "newEmployeeName"
              ).value,

            department:
              document.getElementById(
                "newEmployeeDepartment"
              ).value
          })
      }
    );

    showMessage(
      "Employee added."
    );

    await reload();

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  }

}

async function removeEmployee(id) {

  if (
    !confirm(
      "Remove this employee from the active roster?"
    )
  ) {

    return;

  }

  try {

    await api(
      "/api/employees/" +
      id,
      {
        method:"DELETE"
      }
    );

    await reload();

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  }

}

function renderUpload() {

  document.getElementById(
    "upload"
  ).innerHTML =

    '<div class="grid2">' +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">AI DOCUMENT READER</div>' +

    "<h2>Upload request sheet</h2>" +

    '<div class="sub">PDF, JPG, PNG or WEBP · 10 MB maximum</div>' +

    "</div>" +

    "</div>" +

    '<form id="uploadForm">' +

    '<label class="upload" for="sheetFile">' +

    '<div class="upicon">↑</div>' +

    "<strong>Click to choose the time-off request sheet</strong>" +

    "<p>The AI reads employee, dates, full or partial day, time range, total hours and approval.</p>" +

    '<input id="sheetFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required>' +

    '<div class="chosen" id="chosenFile"></div>' +

    "</label>" +

    '<button id="readSheetButton" class="btn primary" style="width:100%;margin-top:13px;padding:13px">' +

    "Read request sheet" +

    "</button>" +

    "</form>" +

    "</div>" +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">WORKFLOW</div>' +

    "<h2>What happens</h2>" +

    "</div>" +

    "</div>" +

    personRow(
      "1. Upload",
      "Choose the scanned request.",
      ""
    ) +

    personRow(
      "2. AI reads it",
      "Dates and hours are extracted.",
      ""
    ) +

    personRow(
      "3. Review",
      "Confirm the information.",
      ""
    ) +

    personRow(
      "4. Save",
      "The calendars update.",
      ""
    ) +

    "</div>" +

    "</div>";

  var fileInput =
    document.getElementById(
      "sheetFile"
    );

  fileInput.addEventListener(
    "change",
    function() {

      document.getElementById(
        "chosenFile"
      ).textContent =
        fileInput.files[0]
          ? fileInput.files[0].name
          : "";

    }
  );

  document.getElementById(
    "uploadForm"
  ).addEventListener(
    "submit",
    readSheet
  );

}

async function readSheet(event) {

  event.preventDefault();

  var file =
    document.getElementById(
      "sheetFile"
    ).files[0];

  var button =
    document.getElementById(
      "readSheetButton"
    );

  if (!file) {
    return;
  }

  button.disabled =
    true;

  button.textContent =
    "Reading sheet…";

  try {

    var form =
      new FormData();

    form.append(
      "file",
      file
    );

    var result =
      await api(
        "/api/read-sheet",
        {
          method:"POST",
          body:form
        }
      );

    openExtracted(
      result.extracted
    );

    showMessage(
      "Sheet read successfully. Review before saving."
    );

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  } finally {

    button.disabled =
      false;

    button.textContent =
      "Read request sheet";

  }

}

function employeeOptions(
  selectedId
) {

  var html =
    '<option value="">— Select/match employee —</option>';

  state.employees.forEach(
    function(emp) {

      html +=
        '<option value="' +
        emp.id +
        '"' +

        (
          String(emp.id) ===
          String(
            selectedId || ""
          )

            ? " selected"

            : ""
        ) +

        ">" +

        escapeHtml(
          emp.name
        ) +

        " — " +

        escapeHtml(
          emp.department || ""
        ) +

        "</option>";

    }
  );

  return html;

}

function wireEmployeeSelect() {

  document.getElementById(
    "employeeSelect"
  ).addEventListener(
    "change",
    function(event) {

      var emp =
        state.employees.find(
          function(item) {

            return (
              String(
                item.id
              ) ===
              event.target.value
            );

          }
        );

      if (emp) {

        document.getElementById(
          "employeeName"
        ).value =
          emp.name;

        document.getElementById(
          "department"
        ).value =
          emp.department || "";

      }

    }
  );

}

function setRequestForm(
  row,
  id
) {

  row =
    row || {};

  document.getElementById(
    "reqId"
  ).value =
    id || "";

  document.getElementById(
    "employeeSelect"
  ).innerHTML =
    employeeOptions(
      row.employee_id || ""
    );

  document.getElementById(
    "employeeName"
  ).value =
    row.employee_name || "";

  document.getElementById(
    "department"
  ).value =
    row.department || "";

  var allowedTypes = [
    "PTO",
    "Vacation",
    "Sick",
    "Personal",
    "Unpaid",
    "Bereavement",
    "Time Off"
  ];

  document.getElementById(
    "requestType"
  ).value =
    allowedTypes.includes(
      row.request_type
    )

      ? row.request_type

      : "Time Off";

  document.getElementById(
    "startDate"
  ).value =
    row.start_date || "";

  document.getElementById(
    "endDate"
  ).value =
    row.end_date || "";

  document.getElementById(
    "dayType"
  ).value =
    row.day_type ===
      "Partial Day"

      ? "Partial Day"

      : "Full Day";

  document.getElementById(
    "startTime"
  ).value =
    row.start_time || "";

  document.getElementById(
    "endTime"
  ).value =
    row.end_time || "";

  document.getElementById(
    "totalHours"
  ).value =
    row.total_hours == null
      ? ""
      : row.total_hours;

  document.getElementById(
    "status"
  ).value =
    [
      "Approved",
      "Pending",
      "Denied"
    ].includes(
      row.status
    )

      ? row.status

      : "Pending";

  document.getElementById(
    "notes"
  ).value =
    row.notes || "";

  document.getElementById(
    "sourceFilename"
  ).value =
    row.source_filename || "";

  wireEmployeeSelect();

}

function newRequest() {

  document.getElementById(
    "modalEyebrow"
  ).textContent =
    "MANUAL ENTRY";

  document.getElementById(
    "modalTitle"
  ).textContent =
    "Add time-off request";

  setRequestForm(
    {
      request_type:"PTO",
      status:"Approved",
      day_type:"Full Day"
    },
    ""
  );

  document.getElementById(
    "modal"
  ).classList.add(
    "show"
  );

}

function openExtracted(row) {

  var match =
    state.employees.find(
      function(emp) {

        return (
          emp.name
            .toLowerCase() ===

          String(
            row.employee_name ||
            ""
          )
            .toLowerCase()
        );

      }
    );

  if (match) {

    row.employee_id =
      match.id;

    if (
      !row.department
    ) {

      row.department =
        match.department;

    }

  }

  document.getElementById(
    "modalEyebrow"
  ).textContent =
    "AI EXTRACTED · " +

    String(
      row.confidence ||
      "Unknown"
    )
      .toUpperCase() +

    " CONFIDENCE";

  document.getElementById(
    "modalTitle"
  ).textContent =
    "Review before saving";

  setRequestForm(
    row,
    ""
  );

  document.getElementById(
    "modal"
  ).classList.add(
    "show"
  );

}

function editRequest(id) {

  var row =
    state.requests.find(
      function(item) {

        return (
          item.id === id
        );

      }
    );

  if (!row) {
    return;
  }

  document.getElementById(
    "modalEyebrow"
  ).textContent =
    "EDIT REQUEST";

  document.getElementById(
    "modalTitle"
  ).textContent =
    row.employee_name;

  setRequestForm(
    row,
    id
  );

  document.getElementById(
    "modal"
  ).classList.add(
    "show"
  );

}

function closeModal() {

  document.getElementById(
    "modal"
  ).classList.remove(
    "show"
  );

}

async function saveRequest(event) {

  event.preventDefault();

  var id =
    document.getElementById(
      "reqId"
    ).value;

  var body = {

    employee_id:
      document.getElementById(
        "employeeSelect"
      ).value ||
      null,

    employee_name:
      document.getElementById(
        "employeeName"
      ).value,

    department:
      document.getElementById(
        "department"
      ).value,

    request_type:
      document.getElementById(
        "requestType"
      ).value,

    start_date:
      document.getElementById(
        "startDate"
      ).value,

    end_date:
      document.getElementById(
        "endDate"
      ).value,

    day_type:
      document.getElementById(
        "dayType"
      ).value,

    start_time:
      document.getElementById(
        "startTime"
      ).value,

    end_time:
      document.getElementById(
        "endTime"
      ).value,

    total_hours:
      document.getElementById(
        "totalHours"
      ).value,

    status:
      document.getElementById(
        "status"
      ).value,

    notes:
      document.getElementById(
        "notes"
      ).value,

    source_filename:
      document.getElementById(
        "sourceFilename"
      ).value
  };

  try {

    await api(
      id

        ? (
            "/api/requests/" +
            id
          )

        : "/api/requests",

      {
        method:
          id
            ? "PUT"
            : "POST",

        body:
          JSON.stringify(
            body
          )
      }
    );

    closeModal();

    showMessage(
      "Time-off request saved."
    );

    await reload();

    if (
      currentView ===
      "upload"
    ) {

      showView(
        "dashboard"
      );

    } else {

      showView(
        currentView
      );

    }

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  }

}

async function deleteRequest(id) {

  if (
    !confirm(
      "Delete this time-off request?"
    )
  ) {

    return;

  }

  try {

    await api(
      "/api/requests/" +
      id,
      {
        method:"DELETE"
      }
    );

    showMessage(
      "Request deleted."
    );

    await reload();

  } catch (err) {

    showMessage(
      err.message,
      true
    );

  }

}

function renderUploadsLog() {

  var rows =
    state.requests
      .filter(
        function(row) {

          return (
            row.source_filename
          );

        }
      )
      .slice()
      .sort(
        function(a,b) {

          return String(
            b.created_at || ""
          ).localeCompare(
            String(
              a.created_at || ""
            )
          );

        }
      );

  if (!rows.length) {

    document.getElementById(
      "uploads"
    ).innerHTML =

      '<div class="card">' +

      '<div class="empty">' +

      "<strong>No uploaded requests yet.</strong>" +

      "Requests saved from the upload screen will appear here." +

      "</div>" +

      "</div>";

    return;

  }

  var html =

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">UPLOAD LOG</div>' +

    "<h2>Uploaded request history</h2>" +

    '<div class="sub">Saved request details and original filename.</div>' +

    "</div>" +

    '<button class="btn" onclick="exportUploadLog()">Download log CSV</button>' +

    "</div>" +

    '<div class="table">' +

    "<table>" +

    "<thead>" +

    "<tr>" +

    "<th>Uploaded</th>" +

    "<th>Employee</th>" +

    "<th>Requested</th>" +

    "<th>Hours</th>" +

    "<th>File</th>" +

    "<th></th>" +

    "</tr>" +

    "</thead>" +

    "<tbody>";

  rows.forEach(
    function(row) {

      html +=

        "<tr>" +

        "<td>" +
        escapeHtml(
          row.created_at || ""
        ) +
        "</td>" +

        "<td>" +

        "<strong>" +
        escapeHtml(
          row.employee_name
        ) +
        "</strong>" +

        "</td>" +

        "<td>" +
        escapeHtml(
          dateRange(row)
        ) +
        "</td>" +

        "<td>" +
        escapeHtml(
          durationText(row)
        ) +
        "</td>" +

        "<td>" +
        escapeHtml(
          row.source_filename || ""
        ) +
        "</td>" +

        "<td>" +

        '<button class="btn" onclick="downloadSavedRecord(' +
        row.id +
        ')">' +

        "Download record" +

        "</button>" +

        "</td>" +

        "</tr>";

    }
  );

  html +=
    "</tbody>" +
    "</table>" +
    "</div>" +
    "</div>";

  document.getElementById(
    "uploads"
  ).innerHTML =
    html;

}

function downloadSavedRecord(id) {

  var row =
    state.requests.find(
      function(item) {

        return (
          item.id === id
        );

      }
    );

  if (!row) {
    return;
  }

  var lines = [

    "PetScript Time-Off Request Record",

    "",

    "Employee: " +
    (
      row.employee_name ||
      ""
    ),

    "Department: " +
    (
      row.department ||
      ""
    ),

    "Requested dates: " +
    dateRange(row),

    "Day type: " +
    (
      row.day_type ||
      "Full Day"
    ),

    "Start time: " +
    (
      row.start_time
        ? formatTime(
            row.start_time
          )
        : ""
    ),

    "End time: " +
    (
      row.end_time
        ? formatTime(
            row.end_time
          )
        : ""
    ),

    "Total hours: " +
    (
      row.total_hours == null
        ? ""
        : row.total_hours
    ),

    "Type: " +
    (
      row.request_type ||
      ""
    ),

    "Status: " +
    (
      row.status ||
      ""
    ),

    "Notes: " +
    (
      row.notes ||
      ""
    ),

    "Original filename: " +
    (
      row.source_filename ||
      ""
    ),

    "Saved at: " +
    (
      row.created_at ||
      ""
    )

  ];

  var blob =
    new Blob(
      [
        lines.join(
          "\n"
        )
      ],
      {
        type:
          "text/plain;charset=utf-8"
      }
    );

  var link =
    document.createElement(
      "a"
    );

  link.href =
    URL.createObjectURL(
      blob
    );

  link.download =
    (
      row.employee_name ||
      "time-off-request"
    )
      .replace(
        /[^a-z0-9_-]+/gi,
        "_"
      ) +
    "_record.txt";

  document.body.appendChild(
    link
  );

  link.click();

  link.remove();

  setTimeout(
    function() {

      URL.revokeObjectURL(
        link.href
      );

    },
    1000
  );

}

function exportUploadLog() {

  var rows =
    state.requests.filter(
      function(row) {

        return (
          row.source_filename
        );

      }
    );

  var csv = [
    [
      "Uploaded",
      "Employee",
      "Department",
      "Start Date",
      "End Date",
      "Day Type",
      "Start Time",
      "End Time",
      "Total Hours",
      "Type",
      "Status",
      "Filename",
      "Notes"
    ]
  ];

  rows.forEach(
    function(row) {

      csv.push([
        row.created_at || "",
        row.employee_name || "",
        row.department || "",
        row.start_date || "",
        row.end_date || "",
        row.day_type || "",
        row.start_time || "",
        row.end_time || "",
        row.total_hours == null
          ? ""
          : row.total_hours,
        row.request_type || "",
        row.status || "",
        row.source_filename || "",
        row.notes || ""
      ]);

    }
  );

  function cell(value) {

    return (
      '"' +
      String(
        value == null
          ? ""
          : value
      ).replace(
        /"/g,
        '""'
      ) +
      '"'
    );

  }

  var content =
    csv
      .map(
        function(row) {

          return row
            .map(cell)
            .join(",");

        }
      )
      .join("\n");

  var blob =
    new Blob(
      [
        content
      ],
      {
        type:
          "text/csv;charset=utf-8"
      }
    );

  var link =
    document.createElement(
      "a"
    );

  link.href =
    URL.createObjectURL(
      blob
    );

  link.download =
    "petscript_time_off_upload_log.csv";

  document.body.appendChild(
    link
  );

  link.click();

  link.remove();

  setTimeout(
    function() {

      URL.revokeObjectURL(
        link.href
      );

    },
    1000
  );

}

function renderCalendar() {

  var holder =
    document.getElementById(
      "calendar"
    );

  if (!holder) {
    return;
  }

  var year =
    calendarCursor
      .getFullYear();

  var month =
    calendarCursor
      .getMonth();

  var first =
    new Date(
      year,
      month,
      1
    );

  var last =
    new Date(
      year,
      month + 1,
      0
    );

  var start =
    new Date(first);

  start.setDate(
    1 -
    first.getDay()
  );

  var end =
    new Date(last);

  end.setDate(
    last.getDate() +
    (
      6 -
      last.getDay()
    )
  );

  var p =
    periodInfo();

  var html =
    "";

  var date =
    new Date(start);

  while (
    date <= end
  ) {

    var dateString =
      localISO(date);

    var rows =
      state.requests.filter(
        function(row) {

          return overlaps(
            row,
            dateString,
            dateString
          );

        }
      );

    html +=

      '<div class="day ' +

      (
        date.getMonth() !==
        month

          ? "other "

          : ""
      ) +

      (
        dateString ===
        p.today

          ? "current"

          : ""
      ) +

      '">' +

      '<div class="daynum">' +

      date.getDate() +

      "</div>";

    rows
      .slice(
        0,
        4
      )
      .forEach(
        function(row) {

          html +=

            '<div class="event" title="' +

            escapeHtml(
              row.employee_name +
              " — " +
              row.request_type +
              " — " +
              durationText(row)
            ) +

            '">' +

            escapeHtml(
              row.employee_name
            ) +

            " · " +

            escapeHtml(
              row.request_type
            ) +

            '<div style="font-size:8px;font-weight:600;margin-top:2px">' +

            escapeHtml(
              durationText(row)
            ) +

            "</div>" +

            "</div>";

        }
      );

    if (
      rows.length >
      4
    ) {

      html +=

        '<div class="sub">+' +

        (
          rows.length -
          4
        ) +

        " more</div>";

    }

    html +=
      "</div>";

    date.setDate(
      date.getDate() + 1
    );

  }

  holder.innerHTML =

    '<div class="card">' +

    '<div class="calbar">' +

    "<div>" +

    '<div class="eyebrow">TEAM LEAVE</div>' +

    "<h2>" +

    new Intl.DateTimeFormat(
      "en-US",
      {
        month:"long",
        year:"numeric"
      }
    ).format(
      first
    ) +

    "</h2>" +

    "</div>" +

    '<div class="calnav">' +

    '<button class="btn" onclick="moveCalendar(-1)">←</button>' +

    '<button class="btn" onclick="calendarCursor=new Date();renderCalendar()">Today</button>' +

    '<button class="btn" onclick="moveCalendar(1)">→</button>' +

    "</div>" +

    "</div>" +

    '<div class="calendarWrap">' +

    '<div class="calendar">' +

    [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat"
    ]
      .map(
        function(day) {

          return (
            '<div class="dow">' +
            day +
            "</div>"
          );

        }
      )
      .join("") +

    html +

    "</div>" +

    "</div>" +

    "</div>" +

    '<div class="card">' +

    '<div class="head">' +

    "<div>" +

    '<div class="eyebrow">ALL REQUESTS</div>' +

    "<h2>Manage requests</h2>" +

    "</div>" +

    '<button class="btn primary" onclick="newRequest()">＋ Add request</button>' +

    "</div>" +

    requestTable(
      state.requests
    ) +

    "</div>";

}

function moveCalendar(amount) {

  calendarCursor =
    new Date(
      calendarCursor.getFullYear(),
      calendarCursor.getMonth() +
      amount,
      1
    );

  renderCalendar();

}

</script>

</body>

</html>`;
