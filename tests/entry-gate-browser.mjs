async page => {
  page.setDefaultTimeout(3000);
  const sent = [];
  const sockets = [];
  const pageSockets = [];
  const consoleErrors = [];
  let resolveSocket;
  let socketWaiter = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`phase=reconnect-route: socket absent; observed=${JSON.stringify(pageSockets)} console=${JSON.stringify(consoleErrors)}`)), 3000);
    resolveSocket = route => { clearTimeout(timer); resolve(route); };
  });
  let currentSocket;
  let commandWaiter;
  let commandCursor = 0;
  let initialSocketPromise;
  const nextCommand = (phase) => new Promise((resolve, reject) => {
    const index = sent.findIndex((message, i) => i >= commandCursor && message.type === 'gate-command');
    if (index >= 0) { commandCursor = index + 1; resolve(sent[index]); return; }
    const timer = setTimeout(() => reject(new Error(`phase=${phase}: gate-command not captured; frames=${JSON.stringify(sent)}`)), 3000);
    commandWaiter = message => { clearTimeout(timer); commandWaiter = null; commandCursor = sent.length; resolve(message); };
  });
  page.on('websocket', socket => pageSockets.push(socket.url()));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.routeWebSocket(/^ws:\/\/(?:127\.0\.0\.1|localhost):8080\/?$/, route => {
    currentSocket = route;
    sockets.push(route);
    route.onMessage(raw => {
      const message = JSON.parse(String(raw));
      sent.push(message);
      if (message.type === 'gate-command') commandWaiter?.(message);
    });
    resolveSocket?.(route);
    resolveSocket = null;
  });
  const step = async (phase, action) => {
    try { return await action(); }
    catch (error) { throw new Error(`phase=${phase}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  initialSocketPromise = socketWaiter();
  await step('navigate-and-hydrate', async () => {
    await page.goto('http://127.0.0.1:4321');
    await page.getByRole('button', { name: 'Abrir barrera' }).waitFor({ state: 'visible' });
    if (!currentSocket) await initialSocketPromise;
  });
  const arm = page.locator('[data-testid="entry-gate-arm"]');
  const snapshot = (spots, gate, ready = true, pending = null) => currentSocket.send(JSON.stringify({ type: 'snapshot', spots, connected: true, updatedAt: null, barriers: null, gate, gateReady: ready, gatePending: pending }));
  await step('initial-confirmed-closed', async () => {
    snapshot([false, false, false, false], 'closed');
    await page.waitForFunction(() => document.querySelector('[data-testid="entry-gate-arm"]')?.getAttribute('aria-label') === 'Barrera de entrada cerrada');
  });
  await step('open-command-and-pending', async () => {
    const commandPromise = nextCommand('open-command');
    await page.getByRole('button', { name: 'Abrir barrera' }).click();
    const open = await commandPromise;
    if (open.action !== 'open' || !/^[A-Za-z0-9_-]{1,48}$/.test(open.requestId)) throw new Error(`invalid command ${JSON.stringify(open)}`);
    snapshot([false, false, false, false], 'closed', true, 'open');
    await page.waitForFunction(() => document.querySelector('[data-testid="entry-gate-arm"]')?.getAttribute('aria-label') === 'Barrera de entrada cerrada');
    if (!(await page.getByRole('button', { name: 'Abrir barrera' }).isDisabled()) || !(await page.getByRole('button', { name: 'Cerrar barrera' }).isDisabled())) throw new Error('both controls must disable while pending');
    currentSocket.send(JSON.stringify({ type: 'gate-result', requestId: 'wrong-id', status: 'confirmed', gate: 'open' }));
    currentSocket.send(JSON.stringify({ type: 'gate-result', requestId: open.requestId, status: 'confirmed', gate: 'open' }));
    if (await arm.evaluate(element => element.classList.contains('gate-open'))) throw new Error('GateResult alone rotated arm');
    if (!(await page.getByRole('button', { name: 'Abrir barrera' }).isDisabled())) throw new Error('server pending should remain until snapshot');
    snapshot([false, false, false, false], 'open');
    await page.waitForFunction(() => document.querySelector('[data-testid="entry-gate-arm"]')?.classList.contains('gate-open'));
  });
  await step('desktop-screenshot', async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await arm.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
    await page.screenshot({ path: 'tests/artifacts/entry-gate-open-desktop.png' });
  });
  await step('full-parking-unknown-and-close', async () => {
    const countBeforeFull = sent.length;
    snapshot([true, true, true, true], 'open');
    await page.waitForFunction(() => [...document.querySelectorAll('.metric-number')][0]?.firstChild?.textContent?.trim() === '0');
    if (!(await page.getByRole('button', { name: 'Abrir barrera' }).isDisabled())) throw new Error('open enabled while full');
    if (sent.length !== countBeforeFull) throw new Error('full state sent a command');
    if (await page.getByRole('button', { name: 'Cerrar barrera' }).isDisabled()) throw new Error('close disabled while full/open');
    await page.getByRole('button', { name: 'Cerrar barrera' }).focus();
    const closePromise = nextCommand('keyboard-close-full');
    await page.keyboard.press('Enter');
    const close = await closePromise;
    if (close.action !== 'close') throw new Error('keyboard close did not send close');
    snapshot([true, true, true, true], 'open', true, 'close');
    if (!(await arm.evaluate(element => element.classList.contains('gate-open')))) throw new Error('pending close moved arm');
    currentSocket.send(JSON.stringify({ type: 'gate-result', requestId: close.requestId, status: 'rejected', gate: 'open', error: 'GATE_BUSY' }));
    snapshot([true, true, true, true], 'open');
    await page.waitForFunction(() => document.querySelector('#entry-gate-status')?.textContent?.includes('barrera ya está en movimiento'));
    if (!(await arm.evaluate(element => element.classList.contains('gate-open')))) throw new Error('rejection changed confirmed position');
    const retryClosePromise = nextCommand('retry-close-full');
    await page.getByRole('button', { name: 'Cerrar barrera' }).click();
    const retryClose = await retryClosePromise;
    currentSocket.send(JSON.stringify({ type: 'gate-result', requestId: retryClose.requestId, status: 'confirmed', gate: 'closed' }));
    snapshot([true, true, true, true], 'closed');
    await page.waitForFunction(() => !document.querySelector('[data-testid="entry-gate-arm"]')?.classList.contains('gate-open'));
  });
  await step('unknown-legacy-serial-offline-disabled', async () => {
    snapshot(null, 'closed');
    await page.waitForFunction(() => document.querySelector('.metric-number')?.firstChild?.textContent?.trim() === '—');
    if (!(await page.getByRole('button', { name: 'Abrir barrera' }).isDisabled())) throw new Error('unknown capacity allowed opening');
    const count = sent.length;
    await page.getByRole('button', { name: 'Abrir barrera' }).evaluate(button => button.click());
    if (sent.length !== count) throw new Error('unknown-capacity UI handler sent a command');
    snapshot(null, null, false);
    await page.waitForFunction(() => document.querySelector('#entry-gate-status')?.textContent?.includes('Esperando'));
    snapshot([false, false, false, false], 'closed', false);
    if (!(await page.getByRole('button', { name: 'Abrir barrera' }).isDisabled())) throw new Error('legacy snapshot left controls enabled');
    snapshot([false, false, false, false], 'closed', true);
    currentSocket.send(JSON.stringify({ type: 'snapshot', spots: [false, false, false, false], connected: false, updatedAt: null, barriers: null, gate: 'closed', gateReady: false }));
    await page.waitForFunction(() => document.querySelector('#entry-gate-status')?.textContent?.includes('Arduino está desconectado'));
    if (!(await page.getByRole('button', { name: 'Cerrar barrera' }).isDisabled())) throw new Error('serial offline left close enabled');
  });
  await step('reconnect-no-replay', async () => {
    currentSocket.send(JSON.stringify({ type: 'snapshot', spots: [false, false, false, false], connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true }));
    const commandCountBeforeClose = sent.filter(message => message.type === 'gate-command').length;
    const reconnectPromise = socketWaiter();
    currentSocket.close();
    await page.waitForFunction(() => document.querySelector('#entry-gate-status')?.textContent?.includes('Sin conexión'));
    currentSocket = await reconnectPromise;
    if (sent.filter(message => message.type === 'gate-command').length !== commandCountBeforeClose) throw new Error('command replayed after reconnect');
  });
  await step('mobile-reduced-motion-screenshot', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('horizontal overflow at 390px');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (await arm.evaluate(element => getComputedStyle(element).transitionDuration !== '0s')) throw new Error('reduced motion is not zero-duration');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'tests/artifacts/entry-gate-mobile.png', fullPage: true });
  });
  if (consoleErrors.length) throw new Error(`phase=browser-console: ${JSON.stringify(consoleErrors)}`);
  return { sent, pageSockets, consoleErrors, screenshots: ['tests/artifacts/entry-gate-open-desktop.png', 'tests/artifacts/entry-gate-mobile.png'] };
}
