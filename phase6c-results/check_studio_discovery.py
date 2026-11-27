from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    page = b.contexts[0].pages[0]
    data = page.evaluate("() => window.ontonStudio.getSnapshot()")
    print(f"project={data['project']['name']} branch={data['project']['branch']} dirty={data['project']['dirty']} tasks={len(data['tasks'])}")
    assert data['project']['name'].startswith('onton-studio-project-')
    assert data['project']['branch'] == 'main'
    assert data['project']['dirty'] is False
    b.close()
