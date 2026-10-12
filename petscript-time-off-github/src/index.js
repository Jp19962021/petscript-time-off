
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB) {
      return new Response(`<!doctype html><html><body style="font-family:Arial;padding:40px">
      <h1>PetScript Time Off</h1>
      <p>GitHub deployment is working.</p>
      <p>Next: create a Cloudflare D1 database and bind it to this Worker with the binding name <b>DB</b>.</p>
      </body></html>`, { headers: { "content-type": "text/html" }});
    }

    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS employees(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        department TEXT DEFAULT '',
        active INTEGER DEFAULT 1
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS time_off_requests(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT NOT NULL,
        department TEXT DEFAULT '',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        request_type TEXT DEFAULT 'PTO',
        status TEXT DEFAULT 'Approved',
        notes TEXT DEFAULT ''
      )`)
    ]);

    if (url.pathname === "/api/data") {
      const employees = await env.DB.prepare("SELECT * FROM employees WHERE active=1 ORDER BY name").all();
      const requests = await env.DB.prepare("SELECT * FROM time_off_requests ORDER BY start_date").all();
      return json({ employees: employees.results, requests: requests.results });
    }

    if (url.pathname === "/api/employees" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare("INSERT INTO employees(name,department) VALUES(?,?)")
        .bind(b.name || "", b.department || "").run();
      return json({ ok:true });
    }

    if (url.pathname === "/api/requests" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare(`
        INSERT INTO time_off_requests(employee_name,department,start_date,end_date,request_type,status,notes)
        VALUES(?,?,?,?,?,?,?)
      `).bind(
        b.employee_name || "",
        b.department || "",
        b.start_date || "",
        b.end_date || "",
        b.request_type || "PTO",
        b.status || "Approved",
        b.notes || ""
      ).run();
      return json({ ok:true });
    }

    return new Response(APP_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers:{ "content-type":"application/json" }
  });
}

const APP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PetScript Time Off</title>
<style>
body{margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#172033}
header{background:#0d2138;color:white;padding:20px 28px}
main{padding:24px;max-width:1200px;margin:auto}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.card{background:white;border:1px solid #e2e7ee;border-radius:14px;padding:18px;margin-bottom:16px}
.card strong.big{font-size:34px;display:block;margin-top:6px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
button{background:#0d2138;color:white;border:0;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer}
input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #dce3eb;border-radius:8px;margin:5px 0 10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px;border-bottom:1px solid #e6eaf0;font-size:13px}
.muted{color:#778195;font-size:12px}
@media(max-width:800px){.cards,.grid{grid-template-columns:1fr 1fr}}
@media(max-width:550px){.cards,.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><h2 style="margin:0">PetScript Time Off Admin</h2></header>
<main>
<div class="cards">
<div class="card"><span class="muted">OFF TODAY</span><strong class="big" id="offToday">0</strong></div>
<div class="card"><span class="muted">THIS WEEK</span><strong class="big" id="offWeek">0</strong></div>
<div class="card"><span class="muted">THIS MONTH</span><strong class="big" id="offMonth">0</strong></div>
<div class="card"><span class="muted">ACTIVE EMPLOYEES</span><strong class="big" id="empCount">0</strong></div>
</div>

<div class="grid">
<div class="card">
<h3>Add Employee</h3>
<input id="empName" placeholder="Employee name">
<input id="empDept" placeholder="Department">
<button onclick="addEmployee()">Add Employee</button>
</div>

<div class="card">
<h3>Add Time Off</h3>
<input id="reqName" placeholder="Employee name">
<input id="reqDept" placeholder="Department">
<label>Start date</label><input type="date" id="startDate">
<label>End date</label><input type="date" id="endDate">
<select id="reqType">
<option>PTO</option><option>Vacation</option><option>Sick</option><option>Personal</option><option>Unpaid</option>
</select>
<select id="reqStatus"><option>Approved</option><option>Pending</option><option>Denied</option></select>
<textarea id="notes" placeholder="Notes"></textarea>
<button onclick="addRequest()">Save Request</button>
</div>
</div>

<div class="card">
<h3>Who is off today</h3>
<div id="todayList" class="muted">No one off today.</div>
</div>

<div class="card">
<h3>All Requests</h3>
<table>
<thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th>Status</th></tr></thead>
<tbody id="requestRows"></tbody>
</table>
</div>
</main>
<script>
let data={employees:[],requests:[]};

async function api(url,opts={}){
  const r=await fetch(url,{
    ...opts,
    headers:{...(opts.body?{"content-type":"application/json"}:{})}
  });
  return r.json();
}
function localISO(d){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function overlap(r,a,b){
  return r.status!=="Denied" && r.start_date<=b && r.end_date>=a;
}
async function load(){
  data=await api("/api/data");
  render();
}
function render(){
  const now=new Date(), today=localISO(now);
  const ws=new Date(now); ws.setDate(now.getDate()-((now.getDay()+6)%7));
  const we=new Date(ws); we.setDate(ws.getDate()+6);
  const ms=new Date(now.getFullYear(),now.getMonth(),1);
  const me=new Date(now.getFullYear(),now.getMonth()+1,0);

  const todayRows=data.requests.filter(r=>overlap(r,today,today));
  const weekRows=data.requests.filter(r=>overlap(r,localISO(ws),localISO(we)));
  const monthRows=data.requests.filter(r=>overlap(r,localISO(ms),localISO(me)));

  offToday.textContent=new Set(todayRows.map(r=>r.employee_name)).size;
  offWeek.textContent=new Set(weekRows.map(r=>r.employee_name)).size;
  offMonth.textContent=new Set(monthRows.map(r=>r.employee_name)).size;
  empCount.textContent=data.employees.length;

  todayList.innerHTML=todayRows.length
    ? todayRows.map(r=>"<div><b>"+r.employee_name+"</b> — "+r.request_type+"</div>").join("")
    : "No one off today.";

  requestRows.innerHTML=data.requests.map(r=>`
    <tr>
      <td><b>${r.employee_name}</b><div class="muted">${r.department||""}</div></td>
      <td>${r.start_date} → ${r.end_date}</td>
      <td>${r.request_type}</td>
      <td>${r.status}</td>
    </tr>`).join("");
}
async function addEmployee(){
  await api("/api/employees",{method:"POST",body:JSON.stringify({
    name:empName.value,department:empDept.value
  })});
  empName.value="";empDept.value="";load();
}
async function addRequest(){
  await api("/api/requests",{method:"POST",body:JSON.stringify({
    employee_name:reqName.value,department:reqDept.value,
    start_date:startDate.value,end_date:endDate.value,
    request_type:reqType.value,status:reqStatus.value,notes:notes.value
  })});
  load();
}
load();
</script>
</body>
</html>`;
