# pi-bridge

Минималистичный доступ к [pi coding agent](https://pi.dev) с телефона через браузер:
одна страница с живым логом сессии (стриминг текста, tool-calls) и полем ввода
с поддержкой steering/follow-up. Без файлов, терминалов и мульти-проектов.

Архитектура:

```
телефон ──HTTPS──> nginx на VPS (TLS + basic auth) ──LAN──> pi-bridge (ноутбук)
                                                             └─ спавнит `pi --mode rpc`
                                                                (JSONL по stdin/stdout)
```

Своей авторизации у моста НЕТ — доступ закрывает nginx (basic auth). WebSocket
живёт по пути `/ws`, страница — `/`, health-check — `/healthz`.

## Файлы

| Файл | Назначение |
|---|---|
| `server.js` | Node-сервер: WS-мост к `pi --mode rpc`, раздача страницы |
| `index.html` | единственная страница (мобильная вёрстка, рендер лога) |
| `test/fake-pi.js` | эмулятор RPC-протокола pi — для теста без pi и без токенов |
| `test/smoke.js` | smoke-тест моста (поднимает сервер с fake-pi, проверяет всё) |
| `pi-bridge.service` | опциональный systemd user-юнит |

## Установка (Arch Linux)

Требуется Node.js >= 20 (проверено на 24) и установленный pi (`pi --version` работает).

```bash
sudo pacman -S nodejs npm        # если ещё нет
mkdir ~/pi-bridge && cp -r <файлы> ~/pi-bridge/
cd ~/pi-bridge && npm install    # ставит единственную зависимость: ws
node test/smoke.js               # опционально: проверка моста без pi (должно быть SMOKE OK)
```

## Запуск

Простой способ (nohup):

```bash
cd ~/pi-bridge
PI_BRIDGE_CWD=/путь/к/проекту nohup node server.js > bridge.log 2>&1 &
```

Мост поднимется на `0.0.0.0:8765` и сам запустит `pi --mode rpc` в указанном каталоге.
Проверка: `curl -s localhost:8765/healthz` → `{"ok":true,"piRunning":true,...}`.

Переменные окружения:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PORT` | `8765` | порт HTTP/WS |
| `HOST` | `0.0.0.0` | слушающий интерфейс |
| `PI_BRIDGE_CWD` | текущий каталог | рабочий каталог pi-сессии (проект) |
| `PI_BRIDGE_CMD` | `pi` | команда (для тестов: `node`) |
| `PI_BRIDGE_ARGS` | `--mode rpc` | аргументы pi |
| `PI_BRIDGE_SESSION_DIR` | — | добавит `--session-dir <dir>` |

Быстрый тест всей цепочки без реальной pi:

```bash
PI_BRIDGE_CMD=node PI_BRIDGE_ARGS="$(pwd)/test/fake-pi.js" node server.js
```

Опционально systemd user-юнит (автозапуск и рестарт):

```bash
mkdir -p ~/.config/systemd/user && cp pi-bridge.service ~/.config/systemd/user/
# поправьте в юните пути и PI_BRIDGE_CWD, затем:
systemctl --user daemon-reload
systemctl --user enable --now pi-bridge
loginctl enable-linger $USER   # работать и без активного логина
```

## nginx (VPS kreagenium.ru)

Файл паролей (если ещё нет):

```bash
printf 'vasya:%s\n' "$(openssl passwd -apr1)" | sudo tee /etc/nginx/pi-web.htpasswd
```

Блок внутри существующего `server { ... }` для 443:

```nginx
location = /piweb { return 301 /piweb/; }

location /piweb/ {
    auth_basic "pi";
    auth_basic_user_file /etc/nginx/pi-web.htpasswd;

    proxy_pass http://<IP-ноутбука>:8765/;   # слэш в конце срезает префикс /piweb/

    proxy_http_version 1.1;                  # WebSocket:
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                # не рвать WS, пока агент думает
    proxy_buffering off;                     # живой стриминг без рывков
}
```

`sudo nginx -t && sudo systemctl reload nginx`.

Важно: префикс безопасен — страница подключает WebSocket относительным путём
(`/piweb/ws` → nginx срезает до `/ws`), авторизация распространяется и на WS-handshake.

## Проверка с телефона

1. `https://kreagenium.ru/piweb/` → окно basic auth (логин/пароль из htpasswd).
2. Заголовок: зелёная точка + имя модели из `get_state`.
3. Сразу подгружается история сессии (`get_messages`).
4. Введите сообщение → `Отправить`: уйдёт как `prompt` (если агент простаивает)
   или как `steer` / `follow-up` (переключатель появляется, пока агент работает).
5. Кнопка «стоп» отправляет `abort`, «новая сессия» — `new_session`.

## Что умеет страница

- стриминг: text_delta, размышления (свёрнуты), tool-calls со статусом и результатом;
- steering: во время работы агента сообщение уходит в очередь (`steer`),
  опционально `follow-up`; счётчик очереди из `queue_update`;
- автопереподключение с backoff + мгновенное при возврате на вкладку
  (телефон рвёт WebSocket при блокировке экрана — это нормально);
- история сессии при переподключении;
- неизвестные типы событий показываются свёрнутым raw-JSON — ничего не теряется.

## Отладка

- `curl -s localhost:8765/healthz` — жив ли мост и процесс pi;
- `bridge.log` — stdout/stderr pi и события моста;
- pi stderr виден и в интерфейсе (красные системные строки);
- вручную поговорить с RPC: `wscat -c ws://localhost:8765/ws` и отправить
  `{"type":"get_state"}` (команды протокола: docs/rpc-commands.md в репозитории pi).

## Безопасность (кратко, подробности в чате)

pi по умолчанию YOLO — агент выполняет bash без подтверждений. Тот, кто прошёл
basic auth, получает фактически shell на ноутбуке. Поэтому: длинный случайный
пароль, только HTTPS, fail2ban на 401, порт 8765 не выставлять наружу (firewall —
только LAN/адрес VPS).

## Ограничения

- одна pi-сессия на экземпляр моста (нужно несколько проектов — запустите
  несколько экземпляров на разных портах);
- продолжить старую сессию с телефона нельзя (можно raw-командой
  `{"type":"switch_session","sessionPath":"..."}` через wscat; в UI — только новая);
- extension_ui_request (UI-взаимодействие расширений pi) не поддерживается —
  отображается как системное событие;
- вывод `tool_execution_update` (промежуточный вывод инструментов) не спамится
  в лог, показывается только финальный результат.
