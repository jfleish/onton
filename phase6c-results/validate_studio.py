from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent / "studio-validation"
root.mkdir(parents=True, exist_ok=True)
errors = []
results = []
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].pages[0]
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror:{exc}"))
    page.wait_for_selector(".brand")
    page.screenshot(path=str(root / "01-dashboard.png"), full_page=True)
    results.append(("dashboard", page.locator("h1").inner_text()))

    for screen, expected in [("gameplan", "Execution map"), ("agents", "Agents in the loop"), ("timeline", "What happened"), ("transcript", "Agent conversations"), ("approvals", "Decision queue")]:
        page.locator(f"[data-page='{screen}']").first.click()
        page.wait_for_selector("h1")
        actual = page.locator("h1").inner_text()
        assert actual == expected, (screen, actual)
        page.screenshot(path=str(root / f"02-{screen}.png"), full_page=True)
        results.append((screen, actual))

    page.locator("[data-page='gameplan']").first.click()
    page.locator("[data-task='task-2']").first.click()
    assert page.locator(".inspector h2").inner_text() == "Harden process capture"
    results.append(("graph-node-selection", "pass"))

    page.locator("[data-page='agents']").first.click()
    page.locator("[data-agent='agent-2']").click()
    assert page.locator(".transcript-head h2").inner_text() == "Atlas"
    results.append(("agent-transcript", "pass"))

    page.locator("[data-page='approvals']").first.click()
    page.locator("[data-action='approve']").click()
    assert "Approved in simulation" in page.locator(".toast").inner_text()
    results.append(("approval-action", "pass"))

    page.locator("[data-page='dashboard']").first.click()
    page.locator("[data-action='simulate']").click()
    assert "Simulation queued" in page.locator(".toast").inner_text()
    results.append(("simulation-action", "pass"))

    page.set_viewport_size({"width": 900, "height": 700})
    page.wait_for_timeout(200)
    page.screenshot(path=str(root / "03-responsive-900.png"), full_page=True)
    overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    assert overflow <= 2, overflow
    results.append(("responsive-900", f"pass overflow={overflow}"))

    page.set_viewport_size({"width": 1440, "height": 940})
    page.screenshot(path=str(root / "04-restored.png"), full_page=True)
    browser.close()

report = root / "REPORT.md"
report.write_text("# Onton Studio validation\n\n" + "\n".join(f"- {name}: {value}" for name, value in results) + "\n\n" + f"- console/page errors: {len(errors)}\n" + "\n".join(f"  - {e}" for e in errors) + "\n", encoding="utf-8")
if errors:
    raise SystemExit("; ".join(errors))
print(f"checks={len(results)} screenshots={len(list(root.glob('*.png')))} errors=0")
