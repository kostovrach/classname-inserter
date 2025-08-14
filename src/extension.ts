import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

const CSS_MODULE_RE = /\.module\.(s?css|sass)$/i;

function getParserPlugins(doc: vscode.TextDocument) {
  const isTS = doc.languageId === 'typescript' || doc.languageId === 'typescriptreact' || doc.fileName.endsWith('.ts') || doc.fileName.endsWith('.tsx');
  const plugins: any[] = ['jsx', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'decorators-legacy'];
  if (isTS) plugins.push('typescript');
  return plugins;
}

function parseCode(code: string, plugins: any[]) {
  return parse(code, {
    sourceType: 'module',
    plugins
  });
}

/** Находим первый импорт CSS-модуля и его локальное имя (default или namespace) */
function findFirstCssModuleImport(ast: t.File): { localName: string; importPath: string; node: t.ImportDeclaration } | null {
  let found: { localName: string; importPath: string; node: t.ImportDeclaration } | null = null;

  traverse(ast, {
    ImportDeclaration(path) {
      if (found) return;
      const src = path.node.source.value;
      if (typeof src !== 'string' || !CSS_MODULE_RE.test(src)) return;

      let localName: string | null = null;
      for (const sp of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(sp)) {
          localName = sp.local.name;
          break;
        }
        if (t.isImportNamespaceSpecifier(sp)) {
          localName = sp.local.name;
          break;
        }
      }
      if (localName) {
        found = { localName, importPath: src, node: path.node };
      }
    }
  });

  return found;
}

/** Возвращает имя JSX-компонента по имени файла */
function guessComponentNameFromFileName(doc: vscode.TextDocument): string {
  const base = doc.fileName.split(/[\\/]/).pop() || 'Component.tsx';
  return base.replace(/\.[^.]+$/, '');
}

/** Приводим значение имени модуля в camelCase */
function toCamelCase(name: string): string {
  return name
    // Разбиваем по границам слов (заглавные буквы, дефисы, подчеркивания)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s\-_]+/)
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

/** Найти JSX-элемент, внутри которого сейчас курсор */
function findInnermostJsxElement(ast: t.File, offset: number): t.JSXElement | null {
  let found: t.JSXElement | null = null;

  traverse(ast, {
    JSXElement(path) {
      const node = path.node;
      if (node.start != null && node.end != null && node.start <= offset && offset <= node.end) {
        found = node;
      }
    }
  });

  return found;
}

/** Получить значение className у этого элемента */
function getClassNameAttr(opening: t.JSXOpeningElement): t.JSXAttribute | null {
  for (const attr of opening.attributes) {
    if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'className') {
      return attr;
    }
  }
  return null;
}

/** Вытащить block из выражения className={OBJECT.block} или {OBJECT.block__elem} */
function extractBlockFromClassName(expr: t.JSXExpressionContainer, objectNames: string[]): string | null {
  let found: string | null = null;

  traverse(
    t.file(t.program([])),
    {
      noScope: true,
    }
  );

  function scan(node: t.Node | null | undefined) {
    if (!node) return;
    if (t.isMemberExpression(node) && t.isIdentifier(node.object) && objectNames.includes(node.object.name)) {
      const prop = node.property;
      let key: string | null = null;
      if (t.isIdentifier(prop)) key = prop.name;
      if (t.isStringLiteral(prop)) key = prop.value;
      if (key) {
        const block = key.split('__')[0];
        found = block;
      }
    }

    // Рекурсивно обходим возможные контейнеры
    if (t.isCallExpression(node)) {
      scan(node.callee);
      node.arguments.forEach(arg => scan(arg as t.Node));
    } else if (t.isTemplateLiteral(node)) {
      node.expressions.forEach(e => scan(e as t.Node));
    } else if (t.isConditionalExpression(node)) {
      scan(node.test); scan(node.consequent); scan(node.alternate);
    } else if (t.isLogicalExpression(node)) {
      scan(node.left); scan(node.right);
    } else if (t.isArrayExpression(node)) {
      node.elements.forEach(e => scan(e as t.Node));
    } else if (t.isObjectExpression(node)) {
      node.properties.forEach(p => {
        if (t.isObjectProperty(p)) { scan(p.value as t.Node); }
      });
    } else if (t.isMemberExpression(node)) {
      scan(node.object as t.Node);
      scan(node.property as t.Node);
    }
  }

  scan(expr.expression as t.Node);
  return found;
}

/** Подняться по предкам и найти ближайший с className, содержащим OBJECT.block */
function findBlockFromAncestors(element: t.JSXElement, objectNames: string[]): string | null {
  let current: any = element as any;
  while (current && current.$parentPath) {
    const opening = (current.node?.openingElement ?? current.openingElement) as t.JSXOpeningElement | undefined;
    if (opening) {
      const attr = getClassNameAttr(opening);
      if (attr && attr.value && t.isJSXExpressionContainer(attr.value)) {
        const block = extractBlockFromClassName(attr.value, objectNames);
        if (block) return block;
      }
    }
    current = current.$parentPath;
  }
  return null;
}

/** установить back-refs $parentPath для подъёма по дереву */
function attachParents(ast: t.File) {
  traverse(ast, {
    enter(path) {
      // @ts-ignore
      for (const key in path.node) {
        const val: any = (path.node as any)[key];
        if (val && typeof val === 'object' && (val.type || Array.isArray(val))) {
        }
      }
      // @ts-ignore
      path.node.$parentPath = path.parentPath;
    }
  });
}

/** Определить, находимся ли мы внутри открывающего тега, чтобы вставить только атрибут */
function isCursorInsideOpeningTag(element: t.JSXElement, offset: number): boolean {
  const open = element.openingElement;
  if (open.start != null && open.end != null) {
    return open.start <= offset && offset <= open.end;
  }
  return false;
}

/** Найти позицию для вставки импорта (сверху после последних 'use strict' / комментариев / shebang) */
function getImportInsertPosition(doc: vscode.TextDocument): vscode.Position {
  const text = doc.getText();
  const shebang = text.startsWith('#!');
  return shebang ? new vscode.Position(1, 0) : new vscode.Position(0, 0);
}

/** Основная команда */
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('bem.insertClassName', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const code = doc.getText();
    const cursor = editor.selection.active;
    const offset = doc.offsetAt(cursor);

    // Парсим AST
    let ast: t.File;
    try {
      ast = parseCode(code, getParserPlugins(doc));
    } catch (e) {
      vscode.window.showErrorMessage('BEM: Не удалось распарсить файл.');
      return;
    }

    attachParents(ast);

    // 1) Ищем первый импорт CSS-модуля
    const cssImport = findFirstCssModuleImport(ast);
    let objectName = cssImport?.localName ?? null;

    // 2) Определяем список возможных имён объектов стилей
    const objectNames: string[] = [];
    if (objectName) objectNames.push(objectName);

    // 3) Находим самый внутренний JSX-элемент под курсором
    const inner = findInnermostJsxElement(ast, offset);

    // 4) Вычисляем block:
    //    а) из предков по className
    //    б) иначе — из имени CSS-модуля (camelCase имени компонента)
    let block: string | null = null;
    if (inner && objectNames.length) {
      block = findBlockFromAncestors(inner, objectNames);
    }
    if (!block) {
      const baseName = cssImport?.importPath
        ? (cssImport.importPath.split('/').pop() || 'Component.module.scss').replace(/\.module\.(s?css|sass)$/i, '')
        : guessComponentNameFromFileName(doc);
      block = toCamelCase(baseName);
    }

    // 5) Если импорта нет — вставим вслепую import <obj> from './<Component>.module.scss'
    if (!objectName) {
      const chosen = await vscode.window.showInputBox({
        prompt: 'Имя объекта для CSS Module',
        value: 'style',
        validateInput: (v) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v) ? undefined : 'Недопустимое имя идентификатора')
      });
      if (!chosen) return;
      objectName = chosen;

      const comp = guessComponentNameFromFileName(doc);
      const importLine = `import ${objectName} from './${comp}.module.scss';\n`;
      const pos = getImportInsertPosition(doc);
      await editor.edit((eb) => eb.insert(pos, importLine));
    }

    // 6) Формируем сниппет
    const objectPlaceholder = new vscode.SnippetString(`\${1:${objectName}}`);
    const elementPlaceholder = new vscode.SnippetString(`\${4}`);
    const tagPlaceholder = new vscode.SnippetString(`\${3:div}`);

    const blockEditable = block ?? 'block';
    const blockPlaceholder = new vscode.SnippetString(`\${2:${blockEditable}}`);

    const insertOnlyAttr = inner && isCursorInsideOpeningTag(inner, offset);

    let snippet: vscode.SnippetString;
    if (insertOnlyAttr) {
      snippet = new vscode.SnippetString(`className={${objectPlaceholder.value}.${blockPlaceholder.value}__${elementPlaceholder.value}}`);
    } else {
      snippet = new vscode.SnippetString(
        `<${tagPlaceholder.value} className={${objectPlaceholder.value}.${blockPlaceholder.value}__${elementPlaceholder.value}}>\n\t$0\n</${tagPlaceholder.value}>`
      );
    }

    await editor.insertSnippet(snippet);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
