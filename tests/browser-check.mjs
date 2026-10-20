async page => {
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const check = (condition, message) => { if (!condition) failures.push(message); };
  page.setDefaultTimeout(4000);
  await page.goto('http://127.0.0.1:4321');
  await page.locator('.parking-bay').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const clock = document.querySelector('.topbar-clock');
    return clock && clock.textContent?.trim() !== '—';
  }, undefined, { timeout: 10000 });

  const bays = page.locator('.parking-bay');
  const metricValues = async () => (await page.locator('.metric-number').allTextContents()).map(value => value.replace(/\s+/g, ' ').trim());
  const eventMessage = () => page.locator('.activity-event').first().locator('strong').textContent();
  const waitForBayState = async (index, state) => page.waitForFunction(({ index, state }) => {
    const bay = document.querySelectorAll('.parking-bay')[index];
    return bay?.getAttribute('aria-label')?.includes(state);
  }, { index, state });
  const waitForMetrics = async (available, occupied, percent) => page.waitForFunction(({ available, occupied, percent }) => {
    const values = [...document.querySelectorAll('.metric-number')].map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    return values[0].startsWith(String(available)) && values[1].startsWith(String(occupied).padStart(2, '0')) && values[3].startsWith(String(percent));
  }, { available, occupied, percent });
  const waitForEvent = async message => page.waitForFunction(message => document.querySelector('.activity-event strong')?.textContent?.includes(message), message);

  check(await bays.count() === 4, 'Expected four bays');
  for (let index = 0; index < 4; index++) {
    await bays.nth(index).click();
    await waitForBayState(index, 'ocupado');
    await waitForMetrics(3 - index, index + 1, (index + 1) * 25);
    await waitForEvent(`Puesto 0${index + 1} ocupado`);
    check((await bays.nth(index).getAttribute('aria-pressed')) === 'true', `Bay ${index + 1} aria-pressed not true when occupied`);
    const opacity = await bays.nth(index).locator('.vehicle').evaluate(element => getComputedStyle(element).opacity);
    if (opacity !== '1') {
      await page.waitForFunction(index => getComputedStyle(document.querySelectorAll('.parking-bay')[index].querySelector('.vehicle')).opacity === '1', index);
    }
    const values = await metricValues();
    check(values[0].startsWith(String(3 - index)), `Available metric after occupying bay ${index + 1}: ${values[0]}`);
    check(values[1].startsWith(String(index + 1).padStart(2, '0')), `Occupied metric after occupying bay ${index + 1}: ${values[1]}`);
    check(values[3].startsWith(String((index + 1) * 25)), `Occupancy metric after occupying bay ${index + 1}: ${values[3]}`);
    check((await eventMessage())?.includes(`Puesto 0${index + 1} ocupado`), `Activity event for bay ${index + 1} missing`);
  }
  const occupiedScreenshot = 'tests/artifacts/demo-occupied-1920x1080.png';
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: occupiedScreenshot });

  for (let index = 3; index >= 0; index--) {
    await bays.nth(index).click();
    await waitForBayState(index, 'libre');
    await waitForMetrics(4 - index, index, index * 25);
    await waitForEvent(`Puesto 0${index + 1} liberado`);
    check((await bays.nth(index).getAttribute('aria-pressed')) === 'false', `Bay ${index + 1} aria-pressed not false when free`);
    const values = await metricValues();
    const occupiedCount = index;
    check(values[0].startsWith(String(4 - occupiedCount)), `Available metric after releasing bay ${index + 1}: ${values[0]}`);
    check(values[1].startsWith(String(occupiedCount).padStart(2, '0')), `Occupied metric after releasing bay ${index + 1}: ${values[1]}`);
    check(values[3].startsWith(String(occupiedCount * 25)), `Occupancy metric after releasing bay ${index + 1}: ${values[3]}`);
    check((await eventMessage())?.includes(`Puesto 0${index + 1} liberado`), `Release event for bay ${index + 1} missing`);
  }
  await bays.first().focus();
  await page.keyboard.press('Enter');
  await waitForBayState(0, 'ocupado');
  await waitForMetrics(3, 1, 25);
  await page.keyboard.press('Enter');
  await waitForBayState(0, 'libre');
  await waitForMetrics(4, 0, 0);
  check(await page.locator('.activity-event').count() === 10, `Expected 10 events, got ${await page.locator('.activity-event').count()}`);
  check((await page.locator('.barriers-panel').innerText()).includes('Demo'), 'Demo barrier state not visible');

  const viewports = [];
  const screenshots = [occupiedScreenshot];
  for (const [width, height] of [[1920,1080],[1366,768],[768,1024],[390,844],[320,844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    const noOverflow = dimensions.width <= dimensions.viewport;
    viewports.push({ size: `${width}x${height}`, noHorizontalOverflow: noOverflow });
    check(noOverflow, `Horizontal overflow at ${width}x${height}: ${dimensions.width} > ${dimensions.viewport}`);
    const path = `tests/artifacts/demo-${width}x${height}.png`;
    await page.screenshot({ path, fullPage: width <= 520 });
    screenshots.push(path);
  }
  check(pageErrors.length === 0, `Page exceptions: ${pageErrors.join(' | ')}`);
  check(consoleErrors.length === 0, `Console errors: ${consoleErrors.join(' | ')}`);
  const report = { failures, viewports, screenshots, consoleErrors, pageErrors };
  if (failures.length) throw new Error(JSON.stringify(report));
  return JSON.stringify(report);
}
