const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VIEW   = path.join(__dirname, '..', 'views', 'dashboard', 'index.ejs');
const ROUTES = path.join(__dirname, '..', 'routes', 'web.js');

test('every static link on the dashboard points at a route that exists', () => {
    const view = fs.readFileSync(VIEW, 'utf8');
    const routes = fs.readFileSync(ROUTES, 'utf8');
    // सिर्फ़ स्थिर hrefs — EJS से बने dynamic hrefs यहाँ नहीं जाँचे जा सकते।
    const hrefs = [...view.matchAll(/href="(\/[a-z0-9/_-]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0, 'expected some static links on the dashboard');
    const missing = hrefs.filter((h) => {
        if (h === '/') return true ? false : false;   // dashboard itself
        const first = '/' + h.split('/').filter(Boolean)[0];
        return !routes.includes(`router.get('${first}'`) && !routes.includes(`router.get('${h}'`);
    });
    assert.deepStrictEqual(missing, [], `dashboard links with no route: ${missing.join(', ')}`);
});
