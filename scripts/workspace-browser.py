"""Functional owner-workspace checks against an isolated server; no live agents or external services."""
import argparse, json, os, sys, tempfile
from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit(3)
p = argparse.ArgumentParser(); p.add_argument('url'); p.add_argument('--jar'); a = p.parse_args()
out = Path(os.environ.get('KITEBOOK_WORKSPACE_SCREENSHOTS', tempfile.mkdtemp(prefix='workspace-browser-'))); out.mkdir(parents=True, exist_ok=True)
errors = []; checks = []
def check(value, label):
    assert value, label
    checks.append(label)
with sync_playwright() as pw:
    if not Path(pw.chromium.executable_path).exists(): sys.exit(3)
    browser = pw.chromium.launch(args=['--no-sandbox']); ctx = browser.new_context(viewport={'width':1440,'height':1000})
    if a.jar:
        cookies = []
        for line in Path(a.jar).read_text().splitlines():
            if line.startswith('#HttpOnly_'): line = line[len('#HttpOnly_'):]
            elif line.startswith('#'): continue
            f = line.split('\t')
            if len(f) == 7: cookies.append({'name':f[5], 'value':f[6], 'domain':f[0], 'path':f[2], 'httpOnly':True})
        ctx.add_cookies(cookies)
    else:
        r = ctx.request.post(a.url+'/start', data=json.dumps({'op':'signin','admin_key':os.environ.get('KITEBOOK_ADMIN_TOKEN','dev-admin-token')}), headers={'content-type':'application/json'})
        check(r.ok and r.json().get('ok'), 'owner sign-in')
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    def api(action, args=None, nonce=None):
        return ctx.request.post(a.url+'/start', data=json.dumps({'op':'workspace','space':'main','action':action,'args':args or {},'nonce':nonce}), headers={'content-type':'application/json'})
    def nonce(): return ctx.request.post(a.url+'/start', data=json.dumps({'op':'nonce'}), headers={'content-type':'application/json'}).json()['result']['nonce']
    page.goto(a.url+'/start'); page.wait_for_selector('#knowledge:not([hidden])'); page.wait_for_function("() => document.querySelector('#memory-state').title.includes('version')")
    check(page.locator('#home').is_hidden(), 'knowledge is the default view')
    check(api('save', {'text':'must not save'}).status == 403, 'owner writes require one-time nonce')
    check(not api('arbitrary-admin-command').json().get('ok'), 'workspace RPC rejects unknown actions')
    unauth = browser.new_context(); check(unauth.request.post(a.url+'/start', data=json.dumps({'op':'workspace','action':'knowledge'}), headers={'content-type':'application/json'}).status == 401, 'anonymous workspace reads refused'); unauth.close()
    held = []
    def hold_refresh(route):
        body = route.request.post_data_json if route.request.method == 'POST' else {}
        if body and body.get('op') == 'workspace' and body.get('action') == 'knowledge' and not held:
            held.append(route)
        else: route.continue_()
    page.route('**/start', hold_refresh)
    page.locator('#memory-refresh').click(); page.wait_for_function("() => document.querySelector('.memory-grid').dataset.loading === 'true'")
    check(page.locator('#memory-refresh svg').evaluate("e => getComputedStyle(e).animationName") == 'workspace-spin', 'refresh animates only while request is pending')
    page.emulate_media(reduced_motion='reduce')
    check(page.locator('#memory-refresh svg').evaluate("e => getComputedStyle(e).animationName") == 'none', 'reduced motion disables loading rotation')
    page.emulate_media(reduced_motion='no-preference'); held[0].continue_(); page.unroute('**/start', hold_refresh)
    page.wait_for_function("() => document.querySelector('.memory-grid').dataset.loading === 'false'")
    check(page.locator('#memory-detail button').evaluate_all("els => els.every(e => getComputedStyle(e).textDecorationLine === 'none')"), 'button controls have no text underline')
    page.locator('#memory-new').click(); page.locator('#memory-edit-title').fill('Workspace browser trial'); page.locator('#memory-edit-text').fill('A shared finding for the next daily agent.'); page.locator('#memory-detail').get_by_role('button',name='Save',exact=True).click()
    entry = page.locator('.memory-item').filter(has_text='Workspace browser trial'); entry.wait_for(); entry.click(); page.locator('#memory-detail').get_by_role('button',name='Edit note',exact=True).click(); page.locator('#memory-edit-text').wait_for()
    check(page.locator('#memory-edit-text').input_value().startswith('A shared finding'), 'saved note is retrieved in full')
    # A second writer wins while the editor is open. Save must preserve the edit and report a conflict.
    rows = api('knowledge').json()['result']['entries']; note = next(x for x in rows if x.get('title') == 'Workspace browser trial'); original = api('entry', {'id':note['id']}).json()['result']
    check(api('save', {'id':note['id'],'if_match':original['sha'],'title':note['title'],'kind':'fact','text':'Correction from another agent.'}, nonce()).json().get('ok'), 'second writer can publish correction')
    page.locator('#memory-edit-text').fill('Local draft must survive a conflict.'); page.locator('#memory-detail').get_by_role('button',name='Save',exact=True).click(); page.wait_for_function("() => document.querySelector('#memory-detail [role=alert]').textContent.includes('conflict')")
    check(page.locator('#memory-edit-text').input_value() == 'Local draft must survive a conflict.', 'conflict preserves local editor content')
    # Reload deliberately discards the draft, then show history and forget with a new version check.
    page.on('dialog', lambda d: d.accept()); page.reload(); page.locator('.memory-item').filter(has_text='Workspace browser trial').click(); page.locator('#memory-detail').get_by_role('button',name='Edit note',exact=True).click(); page.locator('#memory-edit-text').wait_for()
    check(page.locator('#memory-edit-text').input_value() == 'Correction from another agent.', 'correction is the current retrieval result')
    page.locator('#memory-detail').get_by_role('button',name='Cancel',exact=True).click()
    current = api('entry', {'id':note['id']}).json()['result']
    check(api('save', {'id':note['id'],'if_match':current['sha'],'title':note['title'],'kind':'fact','text':'A new published version in the reading pane.'}, nonce()).json().get('ok'), 'publish a reader update')
    page.locator('#memory-refresh').click(); page.wait_for_function("() => document.querySelector('.document-body').textContent.includes('new published version')")
    check('new published version' in page.locator('.document-body').inner_text(), 'selected reader updates without reopening the note')
    page.locator('.document-source > summary').click(); page.wait_for_selector('.version-history li')
    check(page.locator('.version-history li').count() >= 2, 'version history loads')
    page.evaluate("() => {document.activeElement.blur();scrollTo(0,0)}")
    page.screenshot(path=str(out/'knowledge-desktop.png'), full_page=True)
    for width in [320,390,768,1440,2560]:
        page.set_viewport_size({'width':width,'height':950}); page.wait_for_timeout(80)
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), 'no page overflow at '+str(width))
    page.set_viewport_size({'width':390,'height':844}); page.screenshot(path=str(out/'knowledge-mobile.png'), full_page=True)
    page.emulate_media(color_scheme='dark'); page.screenshot(path=str(out/'knowledge-dark.png'), full_page=True)
    # A delayed save completion must not replace an editor opened after that save began.
    page.set_viewport_size({'width':1440,'height':1000})
    race = api('save', {'title':'Delayed save fixture','kind':'fact','text':'Before delayed save'}, nonce()).json()['result']['entries'][0]
    page.locator('#memory-refresh').click(); page.locator('.memory-item').filter(has_text='Delayed save fixture').click()
    page.locator('#memory-detail').get_by_role('button',name='Edit note',exact=True).click(); page.locator('#memory-edit-text').fill('Committed delayed edit')
    held_save = []
    def hold_saved_entry(route):
        try: body = route.request.post_data_json
        except Exception: body = {}
        if body.get('op') == 'workspace' and body.get('action') == 'entry' and body.get('args', {}).get('id') == race['id']: held_save.append(route)
        else: route.continue_()
    page.route('**/start', hold_saved_entry)
    old_save = page.locator('#memory-detail').get_by_role('button', name='Save', exact=True)
    old_save.evaluate('el => window.pendingSaveButton = el'); old_save.click()
    for _ in range(100):
        if held_save: break
        page.wait_for_timeout(20)
    check(bool(held_save) and page.locator('#memory-edit-text').is_disabled(), 'pending save keeps its submitted fields stable')
    page.locator('#memory-new').click(); page.locator('#memory-edit-text').fill('A newer unsaved draft')
    held_save[0].continue_(); page.unroute('**/start', hold_saved_entry)
    page.wait_for_function('() => !window.pendingSaveButton.disabled')
    check(page.locator('#memory-edit-text').input_value() == 'A newer unsaved draft', 'late save completion preserves a newer editor')
    page.locator('#memory-detail').get_by_role('button',name='Cancel',exact=True).click()
    latest_race = api('entry', {'id':race['id']}).json()['result']
    assert api('forget', {'id':race['id'],'if_match':latest_race['sha']}, nonce()).json().get('ok')
    page.locator('.memory-item').filter(has_text='Workspace browser trial').click()
    page.locator('.document-source > summary').click()
    page.locator('#memory-detail').get_by_role('button',name='Forget note',exact=True).click(); page.wait_for_function("() => document.querySelector('#memory-state').textContent.includes('Removed')")
    check(not any(x['id'] == note['id'] for x in api('knowledge').json()['result']['entries']), 'forgotten entry leaves current knowledge')
    page.locator('#memory-files').click(); page.wait_for_function("() => document.querySelector('#memory-state').textContent.startsWith('shared /')")
    check(page.locator('#memory-list').is_visible(), 'file browser opens')
    page.locator('.workspace-nav a[href="/start#tasks"]').click(); page.wait_for_selector('#home:not([hidden])'); check(page.locator('#knowledge').is_hidden(), 'tasks remain directly accessible')
    page.locator('.workspace-nav a[href="/start"]').click(); page.wait_for_selector('#knowledge:not([hidden])')
    page.keyboard.press('Tab'); page.locator('.skip-link').focus(); page.keyboard.press('Enter'); check(page.locator('#knowledge').is_visible(), 'skip link preserves knowledge destination')
    check(not errors, 'no browser script errors: '+repr(errors)); browser.close()
print('workspace browser: '+str(len(checks))+' checks passed')
