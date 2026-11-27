from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    page = b.contexts[0].pages[0]
    data = page.evaluate("() => window.ontonStudio.getSnapshot()")
    print(f"mode={data['mode']} run_status={data['run']['status']} events={len(data['events'])} project={data['project']['name']}")
    assert data['mode'] == 'local'
    assert data['run']['status'] == 'cancelled'
    assert any('cancelled' in event['title'].lower() for event in data['events'])
    b.close()
