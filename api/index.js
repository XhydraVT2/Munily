// Portón API: one Vercel serverless function.
// GET  /api?op=sync&m=<membershipId>   -> who am I + live state (polled by the app)
// POST /api  { op, ...fields }         -> everything else
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID, randomInt } from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);
const COOKIE = 'porton_session';
const key = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

const KINDS = ['guest', 'delivery', 'service', 'ride'];
const AMEN = {
  pool: ['06:00–08:00', '08:00–10:00', '10:00–12:00', '14:00–16:00', '16:00–18:00', '18:00–20:00'],
  gym: ['06:00–08:00', '08:00–10:00', '17:00–19:00', '19:00–21:00'],
  tennis: ['06:00–08:00', '08:00–10:00', '16:00–18:00', '18:00–20:00'],
  bbq: ['12:00–15:00', '15:00–18:00', '18:00–21:00'],
  social: ['10:00–14:00', '14:00–18:00', '18:00–22:00']
};

/* ---------- schema (created on first request, safe to repeat) ---------- */
const SCHEMA = [
  `create table if not exists users(id text primary key, email text unique not null, pass text not null, name text not null, t double precision not null)`,
  `create table if not exists communities(id text primary key, name text not null, city text, pin text not null, admin_uid text not null, admin_name text not null, t double precision not null)`,
  `create table if not exists members(id text primary key, uid text not null, cid text not null, role text not null, name text not null, apt text, status text not null, t double precision not null, unique(uid, role))`,
  `create table if not exists visits(id text primary key, cid text not null, apt text not null, name text not null, kind text, plate text, idno text, via text, status text not null, t double precision not null)`,
  `create table if not exists passes(id text primary key, cid text not null, uid text not null, apt text not null, name text not null, kind text, code text unique not null, expires double precision not null, max_uses int not null default 0, uses int not null default 0, revoked boolean not null default false, t double precision not null)`,
  `create table if not exists bookings(id text primary key, cid text not null, uid text not null, apt text not null, amenity text not null, date text not null, slot text not null, status text not null, t double precision not null)`,
  `create table if not exists posts(id text primary key, cid text not null, title text not null, body text not null, level text not null, t double precision not null)`,
  `create table if not exists alerts(id text primary key, cid text not null, uid text not null, apt text not null, name text not null, ack double precision, closed boolean not null default false, t double precision not null)`,
  `create table if not exists messages(id text primary key, cid text not null, uid text not null, apt text not null, name text not null, sender text not null, body text not null, t double precision not null)`
];
let ready;
const ensure = () => (ready ||= (async () => { for (const s of SCHEMA) await sql.query(s); })());

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const str = (v, max = 100) => String(v ?? '').trim().slice(0, max);
const now = () => Date.now();
const upper = (v, max = 12) => str(v, max).toUpperCase();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

function readCookie(req) {
  const m = /(?:^|;\s*)porton_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
async function getUser(req) {
  const tok = readCookie(req);
  if (!tok || !process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(tok, key());
    return { id: payload.sub, name: payload.name, email: payload.email };
  } catch { return null; }
}
async function startSession(res, u) {
  const jwt = await new SignJWT({ name: u.name, email: u.email })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuedAt().setExpirationTime('30d').sign(key());
  res.setHeader('Set-Cookie', `${COOKIE}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
}
const need = (u) => { if (!u) bad('Please sign in.', 401); return u; };
const only = (m, roles) => { if (!roles.includes(m.role) || m.status !== 'approved') bad('You do not have permission for that.', 403); };

/* ---------- public + account ops ---------- */
const OPS = {
  async register({ q, res }) {
    const email = str(q.email, 120).toLowerCase(), name = str(q.name, 60), password = String(q.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email.');
    if (!name) bad('Enter your name.');
    if (password.length < 8) bad('Use a password with at least 8 characters.');
    if ((await sql`select 1 from users where email=${email}`).length) bad('That email already has an account. Sign in instead.');
    const u = { id: randomUUID(), email, name };
    await sql`insert into users(id,email,pass,name,t) values(${u.id},${email},${await bcrypt.hash(password, 10)},${name},${now()})`;
    await startSession(res, u);
    return { ok: true };
  },
  async login({ q, res }) {
    const email = str(q.email, 120).toLowerCase();
    const [u] = await sql`select * from users where email=${email}`;
    if (!u || !(await bcrypt.compare(String(q.password || ''), u.pass))) bad('Wrong email or password.', 401);
    await startSession(res, u);
    return { ok: true };
  },
  async logout({ res }) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  },
  async sync({ q, user }) {
    if (!user) return { user: null };
    const mems = await sql`select id,uid,cid,role,name,apt,status,t from members where uid=${user.id}`;
    const m = q.m && mems.find((x) => x.id === q.m);
    return { user, mems, state: m ? await buildState(m) : null };
  },
  async createCommunity({ q, user }) {
    need(user);
    if ((await sql`select 1 from members where uid=${user.id} and role='admin'`).length) bad('You already administer a community.');
    const cname = str(q.cname, 60), name = str(q.name, 60) || user.name;
    if (!cname) bad('Enter the community name.');
    let cid;
    for (let i = 0; i < 5; i++) { cid = rnd(6); if (!(await sql`select 1 from communities where id=${cid}`).length) break; }
    const pin = String(randomInt(10000)).padStart(4, '0');
    await sql`insert into communities(id,name,city,pin,admin_uid,admin_name,t) values(${cid},${cname},${str(q.city, 60)},${pin},${user.id},${name},${now()})`;
    await sql`insert into members(id,uid,cid,role,name,apt,status,t) values(${randomUUID()},${user.id},${cid},'admin',${name},null,'approved',${now()})`;
    return { role: 'admin' };
  },
  async joinResident({ q, user }) {
    need(user);
    const cid = upper(q.code), apt = upper(q.apt, 10), name = str(q.name, 60) || user.name;
    if (!apt) bad('Enter your apartment number.');
    if (!(await sql`select 1 from communities where id=${cid}`).length) bad('No community with that code. Check it with your administrator.');
    if ((await sql`select 1 from members where uid=${user.id} and role='resident'`).length) bad('You already have a resident request.');
    await sql`insert into members(id,uid,cid,role,name,apt,status,t) values(${randomUUID()},${user.id},${cid},'resident',${name},${apt},'pending',${now()})`;
    return { role: 'resident' };
  },
  async joinGuard({ q, user }) {
    need(user);
    const cid = upper(q.code), name = str(q.name, 60) || user.name;
    const [c] = await sql`select pin from communities where id=${cid}`;
    if (!c || c.pin !== str(q.pin, 4)) bad('Code or PIN did not match.');
    if ((await sql`select 1 from members where uid=${user.id} and role='guard'`).length) bad('You already have a guard account.');
    await sql`insert into members(id,uid,cid,role,name,apt,status,t) values(${randomUUID()},${user.id},${cid},'guard',${name},null,'approved',${now()})`;
    return { role: 'guard' };
  },
  async act({ q, user }) {
    need(user);
    const [m] = await sql`select * from members where id=${str(q.m, 60)} and uid=${user.id}`;
    if (!m) bad('That account is not yours.', 403);
    const h = ACT[q.type];
    if (!h) bad('Unknown action.');
    return (await h(m, q, user)) || { ok: true };
  }
};

/* ---------- role-scoped actions ---------- */
const ACT = {
  async visitSet(m, q) {
    if (m.role === 'resident') {
      only(m, ['resident']);
      if (!['approved', 'denied'].includes(q.status)) bad('Invalid status.');
      await sql`update visits set status=${q.status} where id=${q.id} and cid=${m.cid} and apt=${m.apt}`;
    } else {
      only(m, ['guard', 'admin']);
      if (!['approved', 'denied', 'entered'].includes(q.status)) bad('Invalid status.');
      await sql`update visits set status=${q.status}, via=coalesce(${q.via ? str(q.via, 20) : null}, via) where id=${q.id} and cid=${m.cid}`;
    }
  },
  async simulate(m) {
    only(m, ['resident']);
    const P = [['Rappi courier', 'delivery', ''], ['Carlos Méndez', 'guest', 'EB-9012'], ['Plomería Express', 'service', 'AC-3345'], ['Uber · Ricardo', 'ride', 'AD-7781']];
    const p = P[randomInt(P.length)];
    await sql`insert into visits(id,cid,apt,name,kind,plate,idno,via,status,t) values(${randomUUID()},${m.cid},${m.apt},${p[0]},${p[1]},${p[2]},'','Gate','pending',${now()})`;
  },
  async visitCreate(m, q) {
    only(m, ['guard', 'admin']);
    const name = str(q.name, 60), apt = upper(q.apt, 10), kind = KINDS.includes(q.kind) ? q.kind : 'guest';
    if (!name || !apt) bad('Enter the visitor name and apartment.');
    await sql`insert into visits(id,cid,apt,name,kind,plate,idno,via,status,t) values(${randomUUID()},${m.cid},${apt},${name},${kind},${upper(q.plate, 10)},${str(q.idno, 20)},'Gate','pending',${now()})`;
    const ringing = (await sql`select 1 from members where cid=${m.cid} and role='resident' and status='approved' and apt=${apt}`).length > 0;
    return { ringing };
  },
  async passCreate(m, q) {
    only(m, ['resident']);
    const name = str(q.name, 60);
    if (!name) bad('Enter the visitor name.');
    const d = new Date();
    let expires;
    if (q.valid === '24h') expires = now() + 864e5;
    else if (q.valid === '7d') expires = now() + 7 * 864e5;
    else if (q.valid === '30d') expires = now() + 30 * 864e5;
    else { d.setHours(23, 59, 0, 0); expires = d.getTime(); }
    const kind = KINDS.includes(q.kind) ? q.kind : 'guest';
    await sql`insert into passes(id,cid,uid,apt,name,kind,code,expires,max_uses,uses,revoked,t) values(${randomUUID()},${m.cid},${m.uid},${m.apt},${name},${kind},${'PZ-' + rnd(6)},${expires},${q.single ? 1 : 0},0,false,${now()})`;
  },
  async passRevoke(m, q) {
    only(m, ['resident']);
    await sql`update passes set revoked=true where id=${q.id} and uid=${m.uid}`;
  },
  async passScan(m, q) {
    only(m, ['guard', 'admin']);
    const code = upper(q.code, 12);
    const [p] = await sql`select * from passes where cid=${m.cid} and code=${code}`;
    if (!p) return { result: { title: 'Unknown code', sub: 'No pass matches ' + code, pill: ['Deny', 'alert'] } };
    const why = p.revoked ? 'revoked' : p.expires < now() ? 'expired' : p.max_uses && p.uses >= p.max_uses ? 'used' : null;
    if (why) return { result: { title: p.name, sub: 'Pass is ' + why + '. Do not admit.', pill: ['Deny', 'alert'] } };
    await sql`update passes set uses=uses+1 where id=${p.id}`;
    await sql`insert into visits(id,cid,apt,name,kind,plate,idno,via,status,t) values(${randomUUID()},${m.cid},${p.apt},${p.name},${p.kind},'','','Pass','entered',${now()})`;
    return { result: { title: p.name, sub: 'Valid pass for Apt ' + p.apt + '. Entry logged.', pill: ['Admit', 'ok'] } };
  },
  async bookingCreate(m, q) {
    only(m, ['resident']);
    const slots = AMEN[q.amenity];
    if (!slots || !slots.includes(q.slot) || !/^\d{4}-\d{2}-\d{2}$/.test(q.date || '')) bad('Pick an area, date and time slot.');
    if ((await sql`select 1 from bookings where cid=${m.cid} and amenity=${q.amenity} and date=${q.date} and slot=${q.slot} and status='confirmed'`).length) bad('That slot was just taken. Pick another.');
    await sql`insert into bookings(id,cid,uid,apt,amenity,date,slot,status,t) values(${randomUUID()},${m.cid},${m.uid},${m.apt},${q.amenity},${q.date},${q.slot},'confirmed',${now()})`;
  },
  async bookingCancel(m, q) {
    if (m.role === 'admin') { only(m, ['admin']); await sql`update bookings set status='cancelled' where id=${q.id} and cid=${m.cid}`; }
    else { only(m, ['resident']); await sql`update bookings set status='cancelled' where id=${q.id} and uid=${m.uid}`; }
  },
  async alertCreate(m) {
    only(m, ['resident']);
    if ((await sql`select 1 from alerts where uid=${m.uid} and cid=${m.cid} and closed=false`).length) return;
    await sql`insert into alerts(id,cid,uid,apt,name,ack,closed,t) values(${randomUUID()},${m.cid},${m.uid},${m.apt},${m.name},null,false,${now()})`;
  },
  async alertAck(m, q) {
    only(m, ['guard', 'admin']);
    await sql`update alerts set ack=${now()} where id=${q.id} and cid=${m.cid}`;
  },
  async alertClose(m, q) {
    if (m.role === 'resident') { only(m, ['resident']); await sql`update alerts set closed=true where id=${q.id} and uid=${m.uid}`; }
    else { only(m, ['guard', 'admin']); await sql`update alerts set closed=true where id=${q.id} and cid=${m.cid}`; }
  },
  async memberSet(m, q) {
    only(m, ['admin']);
    if (!['approved', 'rejected', 'removed'].includes(q.status)) bad('Invalid status.');
    await sql`update members set status=${q.status} where id=${q.id} and cid=${m.cid} and role='resident'`;
  },
  async reapply(m) {
    only({ ...m, status: 'approved' }, ['resident']);
    await sql`update members set status='pending', t=${now()} where id=${m.id} and status in ('rejected','removed')`;
  },
  async postCreate(m, q) {
    only(m, ['admin']);
    const title = str(q.title, 80), body = str(q.body, 400);
    if (!title || !body) bad('Add a title and a message.');
    await sql`insert into posts(id,cid,title,body,level,t) values(${randomUUID()},${m.cid},${title},${body},${q.level === 'Important' ? 'Important' : 'Info'},${now()})`;
  },
  async messageSend(m, q) {
    only(m, ['resident']);
    const text = str(q.text, 400);
    if (!text) bad('Write a message.');
    await sql`insert into messages(id,cid,uid,apt,name,sender,body,t) values(${randomUUID()},${m.cid},${m.uid},${m.apt},${m.name},'res',${text},${now()})`;
  },
  async messageReply(m, q) {
    only(m, ['admin']);
    const text = str(q.text, 400);
    const [r] = await sql`select uid,apt,name from members where cid=${m.cid} and role='resident' and uid=${str(q.uid, 60)}`;
    if (!r || !text) bad('Write a reply.');
    await sql`insert into messages(id,cid,uid,apt,name,sender,body,t) values(${randomUUID()},${m.cid},${r.uid},${r.apt},${r.name},'admin',${text},${now()})`;
  },
  async leave(m) {
    await sql`delete from members where id=${m.id}`;
  }
};

/* ---------- state per role ---------- */
async function buildState(m) {
  const cid = m.cid;
  const [c] = await sql`select * from communities where id=${cid}`;
  if (!c) return { community: null, data: {} };
  const community = { name: c.name, city: c.city, adminName: c.admin_name, pin: m.role === 'admin' ? c.pin : undefined };
  if (m.status !== 'approved') return { community, data: {} };
  const data = {};
  if (m.role === 'resident') {
    [data.visits, data.passes, data.bookings, data.posts, data.alerts, data.messages] = await Promise.all([
      sql`select id,apt,name,kind,plate,via,status,t from visits where cid=${cid} and apt=${m.apt} order by t desc limit 80`,
      sql`select id,uid,apt,name,kind,code,expires,max_uses as max,uses,revoked,t from passes where cid=${cid} and uid=${m.uid} order by t desc limit 60`,
      sql`select id,uid,apt,amenity,date,slot,status from bookings where cid=${cid} and status='confirmed' and date >= ${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}`,
      sql`select id,title,body,level,t from posts where cid=${cid} order by t desc limit 20`,
      sql`select id,uid,apt,name,ack,closed,t from alerts where cid=${cid} and uid=${m.uid} and closed=false`,
      sql`select id,uid,apt,name,sender as "from",body as text,t from messages where cid=${cid} and uid=${m.uid} order by t asc limit 100`
    ]);
    return { community, data };
  }
  const base = await Promise.all([
    sql`select id,uid,role,name,apt,status,t from members where cid=${cid} and role='resident'`,
    sql`select id,apt,name,kind,plate,via,status,t from visits where cid=${cid} order by t desc limit 80`,
    sql`select id,uid,apt,name,ack,closed,t from alerts where cid=${cid} and closed=false order by t desc`
  ]);
  [data.users, data.visits, data.alerts] = base;
  if (m.role === 'admin') {
    [data.passes, data.bookings, data.posts, data.messages] = await Promise.all([
      sql`select id,uid,apt,name,kind,code,expires,max_uses as max,uses,revoked,t from passes where cid=${cid} order by t desc limit 100`,
      sql`select id,uid,apt,amenity,date,slot,status from bookings where cid=${cid} and status='confirmed' and date >= ${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}`,
      sql`select id,title,body,level,t from posts where cid=${cid} order by t desc limit 20`,
      sql`select id,uid,apt,name,sender as "from",body as text,t from messages where cid=${cid} order by t asc limit 300`
    ]);
  }
  return { community, data };
}

/* ---------- entry ---------- */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) bad('Server is not configured yet. Add DATABASE_URL and JWT_SECRET in Vercel.', 500);
    await ensure();
    const q = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {};
    const fn = OPS[q.op];
    if (!fn) bad('Unknown operation.', 404);
    const out = await fn({ q, req, res, user: await getUser(req) });
    res.status(200).json(out || { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
}
