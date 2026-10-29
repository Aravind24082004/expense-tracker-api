const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Work on a temp copy of the data so tests never touch data/expenses.json
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-')), 'expenses.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'expenses.json'), tmp);
process.env.EXPENSES_FILE = tmp;

const app = require('../src/app');
const server = app.listen(0);
after(() => server.close());

function request(method, urlPath, data) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? null : JSON.stringify(data);
    const req = http.request(
      {
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const json = res.headers['content-type']?.includes('json') ? JSON.parse(body) : body;
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const HEADER = 'date,category,amount,note';

// Data rows of a CSV body whose notes have no embedded newlines
function dataRows(body) {
  return body.split('\n').slice(1, -1);
}

test('GET /expenses/export.csv returns September as CSV, header first, sorted by date', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(!res.body.includes('\r'));
  assert.ok(res.body.endsWith('\n'));
  assert.strictEqual(res.body.split('\n')[0], HEADER);

  const rows = dataRows(res.body);
  assert.strictEqual(rows.length, 18);
  const dates = rows.map((r) => r.slice(0, 10));
  assert.deepStrictEqual(dates, [...dates].sort());
});

test('GET /expenses/export.csv sets the Content-Disposition filename', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="expenses-2026-09-01-2026-09-30.csv"');
});

test('GET /expenses/export.csv quotes a note with a comma and leaves plain notes bare', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  const rows = dataRows(res.body);
  assert.ok(rows.includes('2026-09-05,food,700,"Groceries: rice, dal, oil"'));
  assert.ok(rows.includes('2026-09-16,food,450,Swiggy dinner'));
});

test('GET /expenses/export.csv doubles quotes and quotes newlines in notes', async () => {
  await request('POST', '/expenses', { date: '2026-11-02', amount: 40, category: 'food', note: 'Chai "special"' });
  await request('POST', '/expenses', { date: '2026-11-03', amount: 60, category: 'food', note: 'line one\nline two' });

  const res = await request('GET', '/expenses/export.csv?from=2026-11-01&to=2026-11-30');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('2026-11-02,food,40,"Chai ""special"""\n'));
  assert.ok(res.body.includes('2026-11-03,food,60,"line one\nline two"\n'));
});

test('GET /expenses/export.csv orders by date, not by file order', async () => {
  await request('POST', '/expenses', { date: '2026-12-20', amount: 100, category: 'food', note: 'Later' });
  await request('POST', '/expenses', { date: '2026-12-10', amount: 100, category: 'food', note: 'Earlier' });

  const res = await request('GET', '/expenses/export.csv?from=2026-12-01&to=2026-12-31');
  assert.deepStrictEqual(dataRows(res.body), ['2026-12-10,food,100,Earlier', '2026-12-20,food,100,Later']);
});

test('GET /expenses/export.csv includes both ends of the range', async () => {
  const oneDay = await request('GET', '/expenses/export.csv?from=2026-09-03&to=2026-09-03');
  assert.strictEqual(dataRows(oneDay.body).length, 2);

  const span = await request('GET', '/expenses/export.csv?from=2026-08-31&to=2026-09-02');
  assert.deepStrictEqual(
    dataRows(span.body).map((r) => r.slice(0, 10)),
    ['2026-08-31', '2026-09-02', '2026-09-02']
  );
});

test('GET /expenses/export.csv returns only the header for an empty range', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2025-01-01&to=2025-01-31');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, HEADER + '\n');
});

test('GET /expenses/export.csv rejects missing, invalid or reversed dates with 400', async () => {
  const cases = [
    '',
    '?to=2026-09-30',
    '?from=2026-09-01',
    '?from=2026-9-1&to=2026-09-30',
    '?from=2026-02-30&to=2026-03-01',
    '?from=2026-13-01&to=2026-13-31',
    '?from=2026-09-01&from=2026-09-02&to=2026-09-30',
    '?from=2026-09-01&to=Sept',
    '?from=2026-09-30&to=2026-09-01',
  ];
  for (const q of cases) {
    const res = await request('GET', '/expenses/export.csv' + q);
    assert.strictEqual(res.status, 400, q);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0, q);
  }
});
