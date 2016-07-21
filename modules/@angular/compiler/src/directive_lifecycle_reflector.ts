/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {OnInit, OnDestroy, DoCheck, OnChanges, AfterContentInit, AfterContentChecked, AfterViewInit, AfterViewChecked,} from '@angular/core';
import {reflector, LifecycleHooks} from '../core_private';

import {Type} from './facade/lang';
import {MapWrapper} from './facade/collection';

const LIFECYCLE_INTERFACES: Map<any, Type> = MapWrapper.createFromPairs([
  [LifecycleHooks.OnInit, OnInit],
  [LifecycleHooks.OnDestroy, OnDestroy],
  [LifecycleHooks.DoCheck, DoCheck],
  [LifecycleHooks.OnChanges, OnChanges],
  [LifecycleHooks.AfterContentInit, AfterContentInit],
  [LifecycleHooks.AfterContentChecked, AfterContentChecked],
  [LifecycleHooks.AfterViewInit, AfterViewInit],
  [LifecycleHooks.AfterViewChecked, AfterViewChecked],
]);

const LIFECYCLE_PROPS: Map<any, string> = MapWrapper.createFromPairs([
  [LifecycleHooks.OnInit, 'ngOnInit'],
  [LifecycleHooks.OnDestroy, 'ngOnDestroy'],
  [LifecycleHooks.DoCheck, 'ngDoCheck'],
  [LifecycleHooks.OnChanges, 'ngOnChanges'],
  [LifecycleHooks.AfterContentInit, 'ngAfterContentInit'],
  [LifecycleHooks.AfterContentChecked, 'ngAfterContentChecked'],
  [LifecycleHooks.AfterViewInit, 'ngAfterViewInit'],
  [LifecycleHooks.AfterViewChecked, 'ngAfterViewChecked'],
]);

export function hasLifecycleHook(hook: LifecycleHooks, token: any): boolean {
  var lcInterface = LIFECYCLE_INTERFACES.get(hook);
  var lcProp = LIFECYCLE_PROPS.get(hook);
  return reflector.hasLifecycleHook(token, lcInterface, lcProp);
}
