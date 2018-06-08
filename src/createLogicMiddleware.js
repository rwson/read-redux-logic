import { Observable } from 'rxjs/Observable'; // eslint-disable-line no-unused-vars
import { Subject } from 'rxjs/Subject';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/scan';
import 'rxjs/add/operator/takeWhile';
import 'rxjs/add/operator/toPromise';
import wrapper from './logicWrapper';
import { confirmProps } from './utils';

// confirm custom Rx build imports
confirmProps(Observable.prototype, [
    'filter', 'map', 'scan', 'takeWhile', 'toPromise'
], 'Observable.prototype');

const debug = ( /* ...args */ ) => {};
const OP_INIT = 'init'; // initial monitor op before anything else

function identity(x) { return x; }

/**
   Builds a redux middleware for handling logic (created with
   createLogic). It also provides a way to inject runtime dependencies
   that will be provided to the logic for use during its execution hooks.

   This middleware has two additional methods:
     - `addLogic(arrLogic)` adds additional logic dynamically
     - `replaceLogic(arrLogic)` replaces all logic, existing logic should still complete

   @param {array} arrLogic array of logic items (each created with
     createLogic) used in the middleware. The order in the array
     indicates the order they will be called in the middleware.
   @param {object} deps optional runtime dependencies that will be
     injected into the logic hooks. Anything from config to instances
     of objects or connections can be provided here. This can simply
     testing. Reserved property names: getState, action, and ctx.
   @returns {function} redux middleware with additional methods
     addLogic and replaceLogic
 */

/**
 * 在配置redux store时调用createLogicMiddleware, 返回一个redux中间件, 返回的中间件供applyMiddleware使用
 * @param  {Array}  arrLogic  createLogic创建出来的Logic数组
 * @param  {Object} deps      Logic相关钩子的依赖, 比如可以配置一个封装好的httpClient给每个钩子调用, 可选
 * @return {Function}         redux中间件
 */
export default function createLogicMiddleware(arrLogic = [], deps = {}) {
    //  arrLogic必须是一个数组类型
    if (!Array.isArray(arrLogic)) {
        throw new Error('createLogicMiddleware needs to be called with an array of logic items');
    }

    //  找出重复的Logic并抛出异常
    const duplicateLogic = findDuplicates(arrLogic);
    if (duplicateLogic.length) {
        throw new Error(`duplicate logic, indexes: ${duplicateLogic}`);
    }

    /**
      因为redux-logic集成了rxjs
      所以Subject和BehaviorSubject都是rxjs里的主体
      BehaviorSubject作为Subject的一个变体, 和Subject不同的是它有一个初始值
      https://cn.rx.js.org/manual/overview.html#h15

      创建一些可观察对象, actionSrc$主要用于当前处理的action, monitor$用于全局
    **/
    const actionSrc$ = new Subject();
    const monitor$ = new Subject();
    const lastPending$ = new BehaviorSubject({ op: OP_INIT });

    monitor$
        //  对monitor$使用累加器函数,返回生成的中间值,可选的初始值
        .scan((acc, x) => {
            // 追加一个pending状态的计数器
            let pending = acc.pending || 0;
            switch (x.op) {
                // 当前action位于logic栈的顶级
                case 'top':

                // 开始触发一个action
                case 'begin':
                    pending += 1;
                    break;

                /**
                    在createLogic里的process中调用了done, done的实现稍候分析
                    craeteLogic({
                        ...
                        async process({ getState, action }, dispatch, done) {
                            const res = await someAsyncFunction();
                            dispatch(action);
                            done();
                        }
                    })
                **/
                case 'end':

                // action变成了一个被转换后的新action
                case 'bottom':

                /**
                    在createLogic里的validate中调用了allow, 且触发了一个新的action
                    craeteLogic({
                        ...
                        validate({ getState, action }, allow, reject) {
                            allow(action);
                        }
                    })
                **/
                case 'nextDisp':

                //  无效的action type
                case 'filtered':

                //  派发action的时候异常(好像暂时没用到)
                case 'dispatchError':

                /**
                    在action拦截器(validate)里面执行reject
                    craeteLogic({
                        ...
                        validate({ getState, action }, allow, reject) {
                            reject(action);
                        }
                    })
                **/
                case 'cancelled':
                    pending -= 1;
                    break;
            }
            return {
                ...x,
                pending
            };
        }, { pending: 0 })
        .subscribe(lastPending$);

    let savedStore;
    let savedNext;
    let actionEnd$;
    let logicSub;
    let logicCount = 0;

    //  缓存传入的logic数组
    let savedLogicArr = arrLogic;

    /**
     * 调用完createLogicMiddleware后返回的redux中间件
     * @param  {Object} store redux store, 用来获取最新的redux store
     * @return {Function}
     */
    
     /**
        http://cn.redux.js.org/docs/advanced/Middleware.html
        redux 中间件的结构
        function ({getState}) {
            return function (next) {
                return function (action) {...}
            }
        }
      **/

    function mw(store) {
        //  createLogicMiddleware最多被调用一次
        if (savedStore && savedStore !== store) {
            throw new Error('cannot assign logicMiddleware instance to multiple stores, create separate instance for each');
        }

        //  缓存本次调用传入的store
        savedStore = store;

        return next => {
            savedNext = next;

            //  从applyLogic返回中获取action$, sub, 把logicCount赋值给cnt
            const { action$, sub, logicCount: cnt } = applyLogic(arrLogic, savedStore, savedNext, logicSub, actionSrc$, deps, logicCount, monitor$);
            actionEnd$ = action$;
            logicSub = sub;
            logicCount = cnt;

            return action => {
                debug('starting off', action);
                monitor$.next({ action, op: 'top' });
                actionSrc$.next(action);
                return action;
            };
        };
    }

    /**
        挂载一个monitor$到当前中间件上
     **/
    mw.monitor$ = monitor$;

    /**
       Resolve promise when all in-flight actions are complete passing
       through fn if provided
       @param {function} fn optional fn() which is invoked on completion
       @return {promise} promise resolves when all are complete
      */
    mw.whenComplete = function whenComplete(fn = identity) {
        return lastPending$
            // .do(x => console.log('wc', x)) /* keep commented out */
            .takeWhile(x => x.pending)
            .map(( /* x */ ) => undefined) // not passing along anything
            .toPromise()
            .then(fn);
    };

    /**
     * 给当前redux中间件动态添加依赖
        
        const someLogic = createLogic({
            type: 'SOME_TYPE',
            cancelType: 'CANCEL_TYPE',
            async process({getState, action, cancelle, httpClient}) {
                const res = await httpClient({
                    //  ...
                })
                //  ...
            }
        });
        const someMw = createLogicMiddleware([someLogic]);
        someMw.addDeps({
            httpClient: axios
        });

        //  ...

     * @param {Object} additionalDeps 依赖, 以对象的形式传入
     */
    mw.addDeps = function addDeps(additionalDeps) {
        //  参数必须是一个对象类型
        if (typeof additionalDeps !== 'object') {
            throw new Error('addDeps should be called with an object');
        }
        Object.keys(additionalDeps).forEach(k => {
            const existing = deps[k];
            const newValue = additionalDeps[k];
            //  所添加的中间件依赖不能和当前已有的重名(当前已经有的不能被覆盖)
            if (typeof existing !== 'undefined' && existing !== newValue) {
                throw new Error(`addDeps cannot override an existing dep value: ${k}`);
            }
            deps[k] = newValue;
        });
    };

    /**
     * 给当前redux中间件动态添加新的logic
     * @param arrNewLogic Array.<Logic>
     * @return {Object}
     */
    mw.addLogic = function addLogic(arrNewLogic) {
        if (!arrNewLogic.length) { return { logicCount }; }

        //  合并到当前已有的数组里面
        const combinedLogic = savedLogicArr.concat(arrNewLogic);
        const duplicateLogic = findDuplicates(combinedLogic);

        //  判断是否有重复
        if (duplicateLogic.length) {
            throw new Error(`duplicate logic, indexes: ${duplicateLogic}`);
        }
        const { action$, sub, logicCount: cnt } = applyLogic(arrNewLogic, savedStore, savedNext, logicSub, actionEnd$, deps, logicCount, monitor$);
        actionEnd$ = action$;
        logicSub = sub;
        logicCount = cnt;
        savedLogicArr = combinedLogic;
        debug('added logic');
        return { logicCount: cnt };
    };

    /**
     * 给当前redux中间件合并新的logic
     * @param arrNewLogic Array.<Logic>
     * @return {Object}
     */
    mw.mergeNewLogic = function mergeNewLogic(arrMergeLogic) {
        // 判断是否重复
        const duplicateLogic = findDuplicates(arrMergeLogic);
        if (duplicateLogic.length) {
            throw new Error(`duplicate logic, indexes: ${duplicateLogic}`);
        }
        // 过滤掉重复的
        const arrNewLogic = arrMergeLogic.filter(x => savedLogicArr.indexOf(x) === -1);
        return mw.addLogic(arrNewLogic);
    };

    /**
     * 替换当前所有的logic变成新的logic
     * @param  arrRepLogic  Array.<Logic>
     * @return {Object}
     */
    mw.replaceLogic = function replaceLogic(arrRepLogic) {
        //  判断新的logic数组里是否有重复的logic
        const duplicateLogic = findDuplicates(arrRepLogic);
        if (duplicateLogic.length) {
            throw new Error(`duplicate logic, indexes: ${duplicateLogic}`);
        }
        const { action$, sub, logicCount: cnt } = applyLogic(arrRepLogic, savedStore, savedNext, logicSub, actionSrc$, deps, 0, monitor$);
        actionEnd$ = action$;
        logicSub = sub;
        logicCount = cnt;
        savedLogicArr = arrRepLogic;
        debug('replaced logic');
        return { logicCount: cnt };
    };

    return mw;
}

/**
 * @param  {Array.<Logic>}   arrLogic        Logic数组
 * @param  {Object}         store            redux store
 * @param  {Function}       next             redux中间件中的第二层函数
 * @param  {Rx.Subject}     sub              当前action对应的
 * @param  {Rx.Subject}     actionIn$        当前action对应的可订阅对象
 * @param  {Object}         deps             createLogicMiddle的第二个参数
 * @param  {Number}         startLogicCount  用于命名
 * @param  {Rx.Subject}     monitor$         全局可订阅对象
 * @return {Object}
 */
function applyLogic(arrLogic, store, next, sub, actionIn$, deps, startLogicCount, monitor$) {
    if (!store || !next) { throw new Error('store is not defined'); }

    //  如果当前Logic已经是一个Rx.Subject(已经被订阅过了), 取消订阅
    if (sub) { sub.unsubscribe(); }

    //  对当前Logic数组进行操作(命名等), 返回一个新数组
    const wrappedLogic = arrLogic.map((logic, idx) => {
        //  给当前未指定name的Logic进行命名并且返回, naming稍候分析
        const namedLogic = naming(logic, idx + startLogicCount);

        //  包装命名后的Logic, wrapper稍候分析
        return wrapper(namedLogic, store, deps, monitor$);
    });

    const actionOut$ = wrappedLogic.reduce((acc$, wep) => wep(acc$), actionIn$);

    //  订阅新的Observable对象
    const newSub = actionOut$.subscribe(action => {
        debug('actionEnd$', action);
        try {
            const result = next(action);
            debug('result', result);
        } catch (err) {
            console.error('error in mw dispatch or next call, probably in middlware/reducer/render fn:', err);
            const msg = (err && err.message) ? err.message : err;
            monitor$.next({ action, err: msg, op: 'nextError' });
        }
        //  action变成了一个被转换后的新action
        monitor$.next({ nextAction: action, op: 'bottom' });
    });

    return {
        action$: actionOut$,
        sub: newSub,
        logicCount: startLogicCount + arrLogic.length
    };
}

/**
 * Implement default names for logic using type and idx
 * @param {object} logic named or unnamed logic object
 * @param {number} idx  index in the logic array
 * @return {object} namedLogic named logic
 */

/**
 * 判断当前传入的Logic有没有name, 有就不做任何操作直接返回, 没有就给当前Logic添加一个name属性后返回
 * @param  {Object} logic 当前Logic
 * @param  {Number} idx   当前Logic在arrLogic中的下标地址
 * @return {Object}
 */
function naming(logic, idx) {
    if (logic.name) { return logic; }
    return {
        ...logic,
        name: `L(${logic.type.toString()})-${idx}`
    };
}

/**
  Find duplicates in arrLogic by checking if ref to same logic object
  @param {array} arrLogic array of logic to check
  @return {array} array of indexes to duplicates, empty array if none
 */
/**
 * @param  {Array.<Logic>}  arrLogic Logic数组
 * @return {Array.<Number>}          重复的Logic下标
 */
function findDuplicates(arrLogic) {
    return arrLogic.reduce((acc, x1, idx1) => {
        //  不是同一个下标, 且值相等的情况下就把下标放到acc里面
        if (arrLogic.some((x2, idx2) => (idx1 !== idx2 && x1 === x2))) {
            acc.push(idx1);
        }
        return acc;
    }, []);
}
