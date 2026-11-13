# bb-plugins

Мои плагины для [bb](https://github.com/get-bb/bb) — все в одном репозитории.
Каждый плагин живёт в своём подкаталоге `plugins/<id>/` со своим `package.json`,
зависимостями и сборкой; установка указывает на подкаталог.

| Плагин | Что делает |
| --- | --- |
| [`openrouter-cost`](plugins/openrouter-cost) | Токены и стоимость каждого хода агента по каталогу OpenRouter: страница в сайдбаре, секция в Info треда, бейдж в строке треда, стоимость треда в строке контекста над полем ввода, CLI `bb openrouter-cost`. |

## Установка

```sh
bb plugin install git:https://github.com/eugene-jokerov/bb-plugins.git --subdirectory plugins/openrouter-cost
```

`--subdirectory` обязателен: репозиторий мультиплагинный. bb собирает плагин
при установке (`bb plugin build`), поэтому `dist/` и `node_modules/` в
репозитории не хранятся.

## Обновление

Переустановка тем же адресом подтягивает свежий код; настройки и секреты
плагина сохраняются:

```sh
bb plugin install git:https://github.com/eugene-jokerov/bb-plugins.git --subdirectory plugins/openrouter-cost --yes
bb plugin reload openrouter-cost
```

## Как добавить новый плагин

1. Создать `plugins/<id>/` с полным содержимым плагина (подкаталог должен
   быть самостоятельным пакетом: `package.json` с блоком `bb`, код,
   `README.md`, `.gitignore`, lock-файл).
2. Не коммитить `node_modules/`, `dist/`, `data.db*`, `logs/` — они в `.gitignore`.
3. Добавить строку в таблицу выше.
4. Установка: `bb plugin install git:<url> --subdirectory plugins/<id>`.

`bb` выбирает подкаталог и по имени плагина: `--plugin <bb.name>` вместо
`--subdirectory`. Идентификатор (id) — поле `bb.name` в `package.json`
подкаталога, поэтому он должен быть уникальным внутри репозитория.

## Разработка

```sh
cd plugins/openrouter-cost
npm install
npm run typecheck
npm test
npm run build
```

Локальная установка из рабочей копии во время разработки:

```sh
bb plugin install "$PWD/plugins/openrouter-cost"
```

Установка из локального пути и из git используют один id, поэтому они
сменяют друг друга (настройки плагина при этом остаются).
