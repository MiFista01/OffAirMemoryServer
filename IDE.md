# IDE Extensions for Off-Air Memory (NestJS)

Useful VS Code / Cursor extensions for this NestJS backend. Copy the extension ID to search and install.

## Task Management

### Task Tree
- **Extension ID**: `andres-munoz.tasktree`
- **Description**: Manage tasks directly in IDE using `tasks.json`
- **Usage**: 
  - Tasks are stored in `tasks.json` (should be in Git for team collaboration)
  - Use tags for assignment: `@username` for team member nicknames
  - Combine tags: `@username`, `bug`, `high-priority`

### Bookmarks
- **Extension ID**: `alefragnani.bookmarks`
- **Description**: Bookmarks for quick code navigation
- **Hotkey**: `Ctrl+Alt+K` to create bookmark

## Translation & Internationalization

### Comment Translate
- **Extension ID**: `intellsmi.comment-translate`
- **Description**: Translate comments and strings in code
- **Configuration** (add to `.vscode/settings.json`):
{
  "commentTranslate.targetLanguage": "ru",
  "commentTranslate.maxTranslationLength": 1000000,
  "commentTranslate.browse.enabled": false,
  "commentTranslate.ignore": [],
  "commentTranslate.hover.string": false,
  "commentTranslate.hover.concise": false,
  "commentTranslate.hover.variable": false,
  "commentTranslate.multiLineMerge": false,
  "commentTranslate.hover.content": true,
  "commentTranslate.hover.enabled": true
}
- **Usage**: Hover over comments or strings to see translation

## NestJS Development

### Core NestJS Support
- `ashinzekene.nestjs` - NestJS framework support
- `cutewisp.vscode-nestjs-snippets` - NestJS code snippets
- `manucodes.nestjs-snippets` - Additional NestJS snippets
- `goran-mrzljak.snippets-nestjs` - More NestJS snippets
- `archsense.architecture-view-nestjs` - Architecture overview for NestJS

### Generators
- `imgildev.vscode-nestjs-generator` - Generate NestJS modules/components
- `mauricioross.nestjs-generator` - Alternative NestJS generator
- `czfadmin.nestjs-tool` - NestJS development tools

### Swagger
- `imgildev.vscode-nestjs-swagger-snippets` - Swagger/OpenAPI snippets

### Additional NestJS Tools
- `imgildev.vscode-nestjs-mongoose-snippets` - Mongoose snippets
- `imgildev.vscode-nestjs-sequelize-snippets` - Sequelize snippets
- `imgildev.vscode-nestjs-snippets-extension` - Extended snippets
- `rubiin.nestjs` - NestJS utilities

### NestJS Recommended Settings
Add to `.vscode/settings.json`:
{
  "typescript.suggest.enabled": true,
  "typescript.validate.enable": true,
  "typescript.suggest.includeCompletionsForImportStatements": false,
  "typescript.updateImportsOnFileMove.enabled": "always",
  "javascript.updateImportsOnFileMove.enabled": "always",
  "js/ts.implicitProjectConfig.experimentalDecorators": true,
  "js/ts.implicitProjectConfig.strictFunctionTypes": false
}## TypeScript & JavaScript

### TypeScript Support
- `ms-vscode.vscode-typescript-next` - TypeScript language support
- `steoates.autoimport` - Auto import modules
- `pmneo.tsimporter` - TypeScript import management
- `rbbit.typescript-hero` - TypeScript utilities
- `stringham.move-ts` - Move TypeScript files with imports update

### JavaScript Snippets
- `akamud.vscode-javascript-snippet-pack` - JavaScript snippets
- `nathanchapman.javascriptsnippets` - Additional JS snippets
- `xabikos.javascriptsnippets` - More JS snippets
- `runningcoder.js-snippets` - JS code snippets

### Import Management
- `cmborchert.local-import-intellisense` - Local import intellisense
- `mike-co.import-sorter` - Sort and organize imports
- `christian-kohler.npm-intellisense` - NPM package intellisense
- `christian-kohler.path-intellisense` - Path autocomplete

## Database Tools

### SQLite
- `alexiv.vscode-sqlite` - SQLite database support
- `qwtel.sqlite-viewer` - SQLite database viewer

### MySQL
- `formulahendry.vscode-mysql` - MySQL database support

### MongoDB
- `hansvn.instant-mongo` - MongoDB tools and snippets
- `roerohan.mongo-snippets-for-node-js` - MongoDB snippets for Node.js

### SQL
- `sadeghpm.sql-snippets` - SQL code snippets

## Git & Version Control

- `mhutchie.git-graph` - Visualize Git graph
- `codezombiech.gitignore` - Work with .gitignore files
- `maciejdems.add-to-gitignore` - Quick add to .gitignore

## Code Formatting & Quality

### JSON Formatting
- `supperchong.pretty-json` - JSON formatter
- `chrismeyers.vscode-pretty-json` - Alternative JSON formatter
- `mohsen1.prettify-json` - JSON prettifier
- `meezilla.json` - JSON tools
- `zainchen.json` - JSON utilities

### TypeScript Formatting
- `mylesmurphy.prettify-ts` - TypeScript formatter

### Spell Checking
- `streetsidesoftware.code-spell-checker` - Code spell checker
- `streetsidesoftware.code-spell-checker-russian` - Russian spell checker

## API Testing

- `rangav.vscode-thunder-client` - HTTP client (Postman alternative)
- `postman.postman-for-vscode` - Postman integration

## Utilities

### Comments
- `aaron-bond.better-comments` - Better comment highlighting
- `parthr2031.colorful-comments` - Colorful comments

### Environment Files
- `bernardxiong.env-vscode` - .env file support
- `irongeek.vscode-env` - Alternative .env support

### File Management
- `thinker.data-size-count` - Count data size
- `jannisx11.batch-rename-extension` - Batch rename files
- `yutengjing.vscode-archive` - Archive viewer
- `avive.archive-viewer` - Archive utilities

### Code Utilities
- `adrianwilczynski.terminal-commands` - Terminal commands
- `adrianwilczynski.toggle-hidden` - Toggle hidden files
- `akhail.save-typing` - Save typing utilities
- `tenjojeremy.word-intellisense` - Word intellisense

### Testing
- `hbenl.vscode-test-explorer` - Test explorer
- `ms-vscode.test-adapter-converter` - Test adapter converter