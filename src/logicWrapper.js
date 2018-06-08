import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/merge';
import 'rxjs/add/operator/debounceTime';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/throttleTime';
import createLogicAction$ from './createLogicAction$';
import { confirmProps } from './utils';

// confirm custom Rx build imports
confirmProps(Observable, ['merge'], 'Observable');
confirmProps(Observable.prototype, [
    'debounceTime', 'filter', 'mergeMap', 'share', 'throttleTime'
], 'Observable.prototype');

/**
 * 包装当前Logic返回一个函数
 * @param  {Object}     logic    当前Logic
 * @param  {Object}     store    redux store
 * @param  {Object}     deps     依赖对象
 * @param  {Rx.Subject} monitor$ 全局可订阅对象
 * @return {Function}
 */
export default function logicWrapper(logic, store, deps, monitor$) {

    //  从Logic中获取type, cancelType, latest, debounce, throttle
    const { type, cancelType, latest, debounce, throttle } = logic;

    //  如果同时指定了(latest: true)和type, 把当前type也当一个cancelType, 下一次触发此action时如果当前action还未处理完成, 自动取消
    const cancelTypes = [].concat((type && latest) ? type : []).concat(cancelType || []);

    //  如果指定了去抖动, 就对当前Logic应用, 否则直接执行
    const debouncing = (debounce) ? act$ => act$.debounceTime(debounce) : act$ => act$;

    //  节流和去抖同理
    const throttling = (throttle) ? act$ => act$.throttleTime(throttle) : act$ => act$;

    /**
     把节流和去抖再做一层包装
        const fnA = (arg) => {
            //  ...
            return arg;
        };

        const fnB = (arg) => {
            //  do sth
            return arg;
        };

        const fnC = arg => fnA(fnB(arg));
     **/
    const limiting = act => throttling(debouncing(act));

    /**
     * @param  {Object} actionIn$ [description]
     * @return {Rx.Observable}
     */
    return function wrappedLogic(actionIn$) {
        //  https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-share
        //  返回一个新的Observable, 共享源Observable
        const action$ = actionIn$.share();

        /**
            如果cancelTypes不为空过滤掉不复合条件的action, 否则返回一个新的Observable
            https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-filter
         **/
        const cancel$ = (cancelTypes.length) ? action$.filter(action => matchesType(cancelTypes, action.type)) : Observable.create(() => {});

        // types that don't match will bypass this logic
        const nonMatchingAction$ = action$.filter(action => !matchesType(type, action.type));

        //  对当前符合Logic
        const matchingAction$ = limiting(action$.filter(action => matchesType(type, action.type))).mergeMap(action => createLogicAction$({ action, logic, store, deps, cancel$, monitor$ }));

        //  合并返回一个新的Observable, 可以同时发出每个给定的输入Observable中的所有值
        //  https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-merge
        return Observable.merge(nonMatchingAction$, matchingAction$);
    };
}

/**
 * 判断Logic中的type是否符合
 * @param  {Array|String|RegExp} tStrArrRe 用来比对的type
 * @param  {String}             type       Logic中的type
 * @return {Boolean}
 */
function matchesType(tStrArrRe, type) {
    if (!tStrArrRe) { return false; }
    if (typeof tStrArrRe === 'string') {
        return (tStrArrRe === type || tStrArrRe === '*');
    }
    if (Array.isArray(tStrArrRe)) {
        return tStrArrRe.some(x => matchesType(x, type));
    }
    return tStrArrRe.test(type);
}
