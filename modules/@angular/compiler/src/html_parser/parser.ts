/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {isPresent, isBlank,} from '../facade/lang';
import {ListWrapper} from '../facade/collection';
import * as html from './ast';
import * as lex from './lexer';
import {ParseSourceSpan, ParseError} from '../parse_util';
import {TagDefinition, getNsPrefix, mergeNsAndName} from './tags';
import {DEFAULT_INTERPOLATION_CONFIG, InterpolationConfig} from './interpolation_config';

export class TreeError extends ParseError {
  static create(elementName: string, span: ParseSourceSpan, msg: string): TreeError {
    return new TreeError(elementName, span, msg);
  }

  constructor(public elementName: string, span: ParseSourceSpan, msg: string) { super(span, msg); }
}

export class ParseTreeResult {
  constructor(public rootNodes: html.Node[], public errors: ParseError[]) {}
}

export class Parser {
  constructor(private _getTagDefinition: (tagName: string) => TagDefinition) {}

  parse(
      source: string, url: string, parseExpansionForms: boolean = false,
      interpolationConfig: InterpolationConfig = DEFAULT_INTERPOLATION_CONFIG): ParseTreeResult {
    const tokensAndErrors =
        lex.tokenize(source, url, this._getTagDefinition, parseExpansionForms, interpolationConfig);

    const treeAndErrors = new _TreeBuilder(tokensAndErrors.tokens, this._getTagDefinition).build();

    return new ParseTreeResult(
        treeAndErrors.rootNodes,
        (<ParseError[]>tokensAndErrors.errors).concat(treeAndErrors.errors));
  }
}

class _TreeBuilder {
  private _index: number = -1;
  private _peek: lex.Token;

  private _rootNodes: html.Node[] = [];
  private _errors: TreeError[] = [];

  private _elementStack: html.Element[] = [];

  constructor(
      private tokens: lex.Token[], private getTagDefinition: (tagName: string) => TagDefinition) {
    this._advance();
  }

  build(): ParseTreeResult {
    while (this._peek.type !== lex.TokenType.EOF) {
      if (this._peek.type === lex.TokenType.TAG_OPEN_START) {
        this._consumeStartTag(this._advance());
      } else if (this._peek.type === lex.TokenType.TAG_CLOSE) {
        this._consumeEndTag(this._advance());
      } else if (this._peek.type === lex.TokenType.CDATA_START) {
        this._closeVoidElement();
        this._consumeCdata(this._advance());
      } else if (this._peek.type === lex.TokenType.COMMENT_START) {
        this._closeVoidElement();
        this._consumeComment(this._advance());
      } else if (
          this._peek.type === lex.TokenType.TEXT || this._peek.type === lex.TokenType.RAW_TEXT ||
          this._peek.type === lex.TokenType.ESCAPABLE_RAW_TEXT) {
        this._closeVoidElement();
        this._consumeText(this._advance());
      } else if (this._peek.type === lex.TokenType.EXPANSION_FORM_START) {
        this._consumeExpansion(this._advance());
      } else {
        // Skip all other tokens...
        this._advance();
      }
    }
    return new ParseTreeResult(this._rootNodes, this._errors);
  }

  private _advance(): lex.Token {
    const prev = this._peek;
    if (this._index < this.tokens.length - 1) {
      // Note: there is always an EOF token at the end
      this._index++;
    }
    this._peek = this.tokens[this._index];
    return prev;
  }

  private _advanceIf(type: lex.TokenType): lex.Token {
    if (this._peek.type === type) {
      return this._advance();
    }
    return null;
  }

  private _consumeCdata(startToken: lex.Token) {
    this._consumeText(this._advance());
    this._advanceIf(lex.TokenType.CDATA_END);
  }

  private _consumeComment(token: lex.Token) {
    const text = this._advanceIf(lex.TokenType.RAW_TEXT);
    this._advanceIf(lex.TokenType.COMMENT_END);
    const value = isPresent(text) ? text.parts[0].trim() : null;
    this._addToParent(new html.Comment(value, token.sourceSpan));
  }

  private _consumeExpansion(token: lex.Token) {
    const switchValue = this._advance();

    const type = this._advance();
    const cases: html.ExpansionCase[] = [];

    // read =
    while (this._peek.type === lex.TokenType.EXPANSION_CASE_VALUE) {
      let expCase = this._parseExpansionCase();
      if (isBlank(expCase)) return;  // error
      cases.push(expCase);
    }

    // read the final }
    if (this._peek.type !== lex.TokenType.EXPANSION_FORM_END) {
      this._errors.push(
          TreeError.create(null, this._peek.sourceSpan, `Invalid ICU message. Missing '}'.`));
      return;
    }
    const sourceSpan = new ParseSourceSpan(token.sourceSpan.start, this._peek.sourceSpan.end);
    this._addToParent(new html.Expansion(
        switchValue.parts[0], type.parts[0], cases, sourceSpan, switchValue.sourceSpan));

    this._advance();
  }

  private _parseExpansionCase(): html.ExpansionCase {
    const value = this._advance();

    // read {
    if (this._peek.type !== lex.TokenType.EXPANSION_CASE_EXP_START) {
      this._errors.push(
          TreeError.create(null, this._peek.sourceSpan, `Invalid ICU message. Missing '{'.`));
      return null;
    }

    // read until }
    const start = this._advance();

    const exp = this._collectExpansionExpTokens(start);
    if (isBlank(exp)) return null;

    const end = this._advance();
    exp.push(new lex.Token(lex.TokenType.EOF, [], end.sourceSpan));

    // parse everything in between { and }
    const parsedExp = new _TreeBuilder(exp, this.getTagDefinition).build();
    if (parsedExp.errors.length > 0) {
      this._errors = this._errors.concat(<TreeError[]>parsedExp.errors);
      return null;
    }

    const sourceSpan = new ParseSourceSpan(value.sourceSpan.start, end.sourceSpan.end);
    const expSourceSpan = new ParseSourceSpan(start.sourceSpan.start, end.sourceSpan.end);
    return new html.ExpansionCase(
        value.parts[0], parsedExp.rootNodes, sourceSpan, value.sourceSpan, expSourceSpan);
  }

  private _collectExpansionExpTokens(start: lex.Token): lex.Token[] {
    const exp: lex.Token[] = [];
    const expansionFormStack = [lex.TokenType.EXPANSION_CASE_EXP_START];

    while (true) {
      if (this._peek.type === lex.TokenType.EXPANSION_FORM_START ||
          this._peek.type === lex.TokenType.EXPANSION_CASE_EXP_START) {
        expansionFormStack.push(this._peek.type);
      }

      if (this._peek.type === lex.TokenType.EXPANSION_CASE_EXP_END) {
        if (lastOnStack(expansionFormStack, lex.TokenType.EXPANSION_CASE_EXP_START)) {
          expansionFormStack.pop();
          if (expansionFormStack.length == 0) return exp;

        } else {
          this._errors.push(
              TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
          return null;
        }
      }

      if (this._peek.type === lex.TokenType.EXPANSION_FORM_END) {
        if (lastOnStack(expansionFormStack, lex.TokenType.EXPANSION_FORM_START)) {
          expansionFormStack.pop();
        } else {
          this._errors.push(
              TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
          return null;
        }
      }

      if (this._peek.type === lex.TokenType.EOF) {
        this._errors.push(
            TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
        return null;
      }

      exp.push(this._advance());
    }
  }

  private _consumeText(token: lex.Token) {
    let text = token.parts[0];
    if (text.length > 0 && text[0] == '\n') {
      const parent = this._getParentElement();
      if (isPresent(parent) && parent.children.length == 0 &&
          this.getTagDefinition(parent.name).ignoreFirstLf) {
        text = text.substring(1);
      }
    }

    if (text.length > 0) {
      this._addToParent(new html.Text(text, token.sourceSpan));
    }
  }

  private _closeVoidElement(): void {
    if (this._elementStack.length > 0) {
      const el = ListWrapper.last(this._elementStack);

      if (this.getTagDefinition(el.name).isVoid) {
        this._elementStack.pop();
      }
    }
  }

  private _consumeStartTag(startTagToken: lex.Token) {
    const prefix = startTagToken.parts[0];
    const name = startTagToken.parts[1];
    const attrs: html.Attribute[] = [];
    while (this._peek.type === lex.TokenType.ATTR_NAME) {
      attrs.push(this._consumeAttr(this._advance()));
    }
    const fullName = this._getElementFullName(prefix, name, this._getParentElement());
    let selfClosing = false;
    // Note: There could have been a tokenizer error
    // so that we don't get a token for the end tag...
    if (this._peek.type === lex.TokenType.TAG_OPEN_END_VOID) {
      this._advance();
      selfClosing = true;
      const tagDef = this.getTagDefinition(fullName);
      if (!(tagDef.canSelfClose || getNsPrefix(fullName) !== null || tagDef.isVoid)) {
        this._errors.push(TreeError.create(
            fullName, startTagToken.sourceSpan,
            `Only void and foreign elements can be self closed "${startTagToken.parts[1]}"`));
      }
    } else if (this._peek.type === lex.TokenType.TAG_OPEN_END) {
      this._advance();
      selfClosing = false;
    }
    const end = this._peek.sourceSpan.start;
    const span = new ParseSourceSpan(startTagToken.sourceSpan.start, end);
    const el = new html.Element(fullName, attrs, [], span, span, null);
    this._pushElement(el);
    if (selfClosing) {
      this._popElement(fullName);
      el.endSourceSpan = span;
    }
  }

  private _pushElement(el: html.Element) {
    if (this._elementStack.length > 0) {
      const parentEl = ListWrapper.last(this._elementStack);
      if (this.getTagDefinition(parentEl.name).isClosedByChild(el.name)) {
        this._elementStack.pop();
      }
    }

    const tagDef = this.getTagDefinition(el.name);
    const {parent, container} = this._getParentElementSkippingContainers();

    if (isPresent(parent) && tagDef.requireExtraParent(parent.name)) {
      const newParent = new html.Element(
          tagDef.parentToAdd, [], [], el.sourceSpan, el.startSourceSpan, el.endSourceSpan);
      this._insertBeforeContainer(parent, container, newParent);
    }

    this._addToParent(el);
    this._elementStack.push(el);
  }

  private _consumeEndTag(endTagToken: lex.Token) {
    const fullName = this._getElementFullName(
        endTagToken.parts[0], endTagToken.parts[1], this._getParentElement());

    if (this._getParentElement()) {
      this._getParentElement().endSourceSpan = endTagToken.sourceSpan;
    }

    if (this.getTagDefinition(fullName).isVoid) {
      this._errors.push(TreeError.create(
          fullName, endTagToken.sourceSpan,
          `Void elements do not have end tags "${endTagToken.parts[1]}"`));
    } else if (!this._popElement(fullName)) {
      this._errors.push(TreeError.create(
          fullName, endTagToken.sourceSpan, `Unexpected closing tag "${endTagToken.parts[1]}"`));
    }
  }

  private _popElement(fullName: string): boolean {
    for (let stackIndex = this._elementStack.length - 1; stackIndex >= 0; stackIndex--) {
      const el = this._elementStack[stackIndex];
      if (el.name == fullName) {
        ListWrapper.splice(this._elementStack, stackIndex, this._elementStack.length - stackIndex);
        return true;
      }

      if (!this.getTagDefinition(el.name).closedByParent) {
        return false;
      }
    }
    return false;
  }

  private _consumeAttr(attrName: lex.Token): html.Attribute {
    const fullName = mergeNsAndName(attrName.parts[0], attrName.parts[1]);
    let end = attrName.sourceSpan.end;
    let value = '';
    if (this._peek.type === lex.TokenType.ATTR_VALUE) {
      const valueToken = this._advance();
      value = valueToken.parts[0];
      end = valueToken.sourceSpan.end;
    }
    return new html.Attribute(fullName, value, new ParseSourceSpan(attrName.sourceSpan.start, end));
  }

  private _getParentElement(): html.Element {
    return this._elementStack.length > 0 ? ListWrapper.last(this._elementStack) : null;
  }

  /**
   * Returns the parent in the DOM and the container.
   *
   * `<ng-container>` elements are skipped as they are not rendered as DOM element.
   */
  private _getParentElementSkippingContainers(): {parent: html.Element, container: html.Element} {
    let container: html.Element = null;

    for (let i = this._elementStack.length - 1; i >= 0; i--) {
      if (this._elementStack[i].name !== 'ng-container') {
        return {parent: this._elementStack[i], container};
      }
      container = this._elementStack[i];
    }

    return {parent: ListWrapper.last(this._elementStack), container};
  }

  private _addToParent(node: html.Node) {
    const parent = this._getParentElement();
    if (isPresent(parent)) {
      parent.children.push(node);
    } else {
      this._rootNodes.push(node);
    }
  }

  /**
   * Insert a node between the parent and the container.
   * When no container is given, the node is appended as a child of the parent.
   * Also updates the element stack accordingly.
   *
   * @internal
   */
  private _insertBeforeContainer(
      parent: html.Element, container: html.Element, node: html.Element) {
    if (!container) {
      this._addToParent(node);
      this._elementStack.push(node);
    } else {
      if (parent) {
        // replace the container with the new node in the children
        const index = parent.children.indexOf(container);
        parent.children[index] = node;
      } else {
        this._rootNodes.push(node);
      }
      node.children.push(container);
      this._elementStack.splice(this._elementStack.indexOf(container), 0, node);
    }
  }

  private _getElementFullName(prefix: string, localName: string, parentElement: html.Element):
      string {
    if (isBlank(prefix)) {
      prefix = this.getTagDefinition(localName).implicitNamespacePrefix;
      if (isBlank(prefix) && isPresent(parentElement)) {
        prefix = getNsPrefix(parentElement.name);
      }
    }

    return mergeNsAndName(prefix, localName);
  }
}

function lastOnStack(stack: any[], element: any): boolean {
  return stack.length > 0 && stack[stack.length - 1] === element;
}
