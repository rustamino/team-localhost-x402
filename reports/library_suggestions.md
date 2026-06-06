# Library suggestions: @x402/hono dynamic route registration

## Problem

`paymentMiddleware(routes, server)` из `@x402/hono@2.14.0` не поддерживает
динамическую регистрацию маршрутов после инициализации.

### Сценарий использования

Любой сервис, где защищённые маршруты создаются в runtime (торговые площадки,
аукционы, IoT-устройства и т.п.):

```
POST /quote  →  создаёт job  →  хочет защитить GET /pay/{job_id}
```

Маршрут `/pay/{job_id}` неизвестен при старте сервера — он появляется после
первого запроса к `/quote`.

---

## Корень проблемы

### `paymentMiddleware` (src: @x402/hono, строки 293-301)

```ts
function paymentMiddleware(routes, server, ...) {
  const httpServer = new x402HTTPResourceServer(server, routes);
  return paymentMiddlewareFromHTTPServer(httpServer, ...);
}
```

Создаёт `x402HTTPResourceServer` один раз и передаёт ему **снапшот** `routes`.

### `x402HTTPResourceServer` constructor (src: @x402/core/http/x402HTTPResourceServer.ts)

```ts
constructor(ResourceServer, routes) {
  this.compiledRoutes = [];
  this.routesConfig = routes;

  const normalizedRoutes =
    typeof routes === "object" && !("accepts" in routes)
      ? routes
      : { "*": routes };

  for (const [pattern, config] of Object.entries(normalizedRoutes)) {
    //                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //   Object.entries() создаёт массив из текущих ключей объекта.
    //   Новые ключи, добавленные позже, сюда не попадут.
    const parsed = this.parseRoutePattern(pattern);
    this.compiledRoutes.push({ verb, regex, config, pattern });
  }
}
```

`compiledRoutes` — единственный источник истины для `requiresPayment()`:

```ts
requiresPayment(context) {
  return this.getRouteConfig(context.path, method) !== undefined;
}

getRouteConfig(path, method) {
  return this.compiledRoutes.find(
    route => route.regex.test(path) && (route.verb === "*" || route.verb === method)
  );
}
```

### Итог

Добавление ключа в объект `routes` после вызова `paymentMiddleware()` не имеет
никакого эффекта. Новый маршрут никогда не попадает в `compiledRoutes`,
`requiresPayment()` возвращает `false`, middleware пропускает запрос, и хэндлер
отвечает `200 OK` вместо `402 Payment Required`.

---

## Текущий workaround

Используется `paymentMiddlewareFromHTTPServer` (уже экспортируется из
`@x402/hono`) + прямая запись в приватные поля через `as any`:

```ts
// 1. Создать httpServer явно, передать его в middleware
httpServer = new x402HTTPResourceServer(x402Server, {});
app.use(paymentMiddlewareFromHTTPServer(httpServer));

// 2. При создании нового job — добавить маршрут напрямую в compiledRoutes
function registerRoute(job: PrintJob) {
  const routeKey = `GET /pay/${job.job_id}`;
  const hs = httpServer as any;
  const parsed = hs.parseRoutePattern(routeKey);   // public method, но не в типах
  hs.compiledRoutes.push({                          // public field, но не в типах
    verb: parsed.verb,
    regex: parsed.regex,
    config: paymentConfig,
    pattern: parsed.path,
  });
}

// 3. При завершении — вырезать из compiledRoutes
function deregisterRoute(jobId: string) {
  const hs = httpServer as any;
  const idx = hs.compiledRoutes.findIndex((r: any) => r.pattern === `/pay/${jobId}`);
  if (idx !== -1) hs.compiledRoutes.splice(idx, 1);
}
```

`compiledRoutes` и `parseRoutePattern` — **не приватные** (нет `private` в TS,
не скрыты из скомпилированного JS), но и не задокументированы как публичный API.
Зависимость от этой детали реализации создаёт риск сломаться при любом
рефакторинге внутри библиотеки.

---

## Предложение PR: метод `registerRoute` / `unregisterRoute`

### Суть

Добавить в `x402HTTPResourceServer` явный публичный API для динамической
регистрации маршрутов:

```ts
// @x402/core — src/http/x402HTTPResourceServer.ts

class x402HTTPResourceServer {
  // ... existing code ...

  /**
   * Register a payment-protected route at runtime.
   * Safe to call after middleware initialisation.
   *
   * @param pattern - Route pattern, e.g. "GET /pay/:id" or "/resource/*"
   * @param config  - Payment requirement config (same shape as static routes)
   */
  registerRoute(pattern: string, config: RouteConfig): void {
    const parsed = this.parseRoutePattern(pattern);
    // Prevent duplicate registration for the same pattern+verb
    const exists = this.compiledRoutes.some(
      r => r.pattern === parsed.path && r.verb === parsed.verb
    );
    if (!exists) {
      this.compiledRoutes.push({
        verb: parsed.verb,
        regex: parsed.regex,
        config,
        pattern: parsed.path,
      });
    }
  }

  /**
   * Remove a previously registered route.
   *
   * @param pattern - The same pattern string passed to registerRoute
   */
  unregisterRoute(pattern: string): void {
    const parsed = this.parseRoutePattern(pattern);
    const idx = this.compiledRoutes.findIndex(
      r => r.pattern === parsed.path && r.verb === parsed.verb
    );
    if (idx !== -1) {
      this.compiledRoutes.splice(idx, 1);
    }
  }
}
```

### Зачем именно такой API, а не Proxy / реактивный объект

| Вариант | Плюсы | Минусы |
|---|---|---|
| `registerRoute()` метод | Явный, типобезопасный, легко тестируется | Нужно хранить ссылку на `httpServer` |
| `Proxy` на объект `routes` | Обратная совместимость — `paymentMiddleware(routes, ...)` продолжает работать без изменений в коде пользователя | Proxy не ловит `Object.assign`, spread, `delete`; сложнее отлаживать |
| Ленивая компиляция в `getRouteConfig` | Не нужен отдельный API | Читает `routesConfig` при каждом запросе — O(n) на горячем пути; нет защиты от гонки |
| `paymentMiddleware` принимает `() => routes` | Работает с существующей сигнатурой | Breaking change в сигнатуре |

Метод `registerRoute` — наименее invasive: не меняет конструктор, не меняет
`paymentMiddleware`, не трогает горячий путь `requiresPayment()`.

### Пример использования после патча

```ts
import { x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } from "@x402/hono";

const httpServer = new x402HTTPResourceServer(x402Server, {});
app.use(paymentMiddlewareFromHTTPServer(httpServer));

// При создании нового платёжного ресурса:
httpServer.registerRoute(`GET /pay/${jobId}`, {
  accepts: [{
    scheme: "exact",
    price: `$${priceUsdc}`,
    network: ALGORAND_TESTNET_CAIP2,
    payTo: avmAddress,
    extra: { asset: Number(USDC_TESTNET_ASA_ID) },
  }],
  description: `Job ${jobId}`,
});

// По завершении (replay protection):
httpServer.unregisterRoute(`GET /pay/${jobId}`);
```

### Что нужно изменить в репо

| Файл | Изменение |
|---|---|
| `packages/x402-core/src/http/x402HTTPResourceServer.ts` | Добавить `registerRoute()` и `unregisterRoute()` |
| `packages/x402-core/src/http/index.ts` | Убедиться, что методы в типах |
| `packages/x402-hono/README.md` | Раздел "Dynamic routes" с примером |
| `packages/x402-core/test/http/x402HTTPResourceServer.test.ts` | Тесты: register → запрос возвращает 402; unregister → 200 |

### Репро для issue / PR description

```ts
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";

const routes: Record<string, unknown> = {};
const app = new Hono();
app.use(paymentMiddleware(routes, server));   // compiledRoutes строится здесь

// Позже добавляем маршрут в объект:
routes["GET /pay/j_abc"] = { accepts: [...] };

// Запрос GET /pay/j_abc → ожидаем 402, получаем 200
// Причина: compiledRoutes не пересчитывается после мутации routes
```

---

## Ссылки

- `@x402/core` v2.14.0:
  `src/http/x402HTTPResourceServer.ts` — конструктор, строки ~1813–1823
- `@x402/hono` v2.14.0:
  `src/index.ts` — `paymentMiddleware`, строки ~293–301
- x402 spec: https://x402.org
