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
    assert "onton-windows" in page.locator("h1").inner_text()
    page.screenshot(path=str(root / "01-dashboard.png"), full_page=True)
    results.append(("local-discovery", page.locator(".runtime").inner_text()))

    for screen, expected in [("gameplan", "Execution map"), ("agents", "Agents in the loop"), ("timeline", "What happened"), ("transcript", "Agent conversations"), ("approvals", "Execution gate")]:
        page.locator(f"[data-page='{screen}']").first.click()
        page.wait_for_selector("h1")
        actual = page.locator("h1").inner_text()
        assert actual == expected, (screen, actual)
        page.screenshot(path=str(root / f"02-{screen}.png"), full_page=True)
        results.append((screen, actual))

    page.locator("[data-page='gameplan']").first.click()
    assert page.locator(".graph-node").count() > 0
    page.locator(".graph-node").first.click()
    assert page.locator(".inspector h2").count() == 1
    results.append(("real-gameplan-graph", f"{page.locator('.graph-node').count()} nodes"))

    page.locator("[data-page='dashboard']").first.click()
    page.locator("[data-action='simulate']").click()
    assert "Local simulation started" in page.locator(".toast").inner_text()
    assert "running" in page.locator(".runtime").inner_text().lower()
    page.locator("[data-action='stop']").click()
    assert "cancelled" in page.locator(".runtime").inner_text().lower()
    results.append(("local-run-lifecycle", "running -> cancelled"))

    page.locator("[data-page='approvals']").first.click()
    assert "disabled" in page.locator(".badge").inner_text().lower()
    results.append(("approval-gate", "disabled"))

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
report.write_text("# Onton Studio validation\n\n" + "\n".join(f"- {name}: {value}" for name, value in results) + "\n\n" + f"- console/page errors: {len(errors)}\n" + "\n".join(f"  - {e}" for e in errors) + "\n\n## Scope\n\n- Real local project discovery and Git metadata: connected.\n- Local persisted run lifecycle and event stream: connected.\n- Coordinator, worker, Codex execution, approvals, pushes, and merges: disabled.\n", encoding="utf-8")
if errors:
    raise SystemExit("; ".join(errors))
print(f"checks={len(results)} screenshots={len(list(root.glob('*.png')))} errors=0")
