import isObservable from 'is-observable';
import isPromise from 'is-promise';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/defaultIfEmpty';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/mergeAll';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import { confirmProps } from './utils';

// confirm custom Rx build imports
confirmProps(Observable, ['fromPromise', 'of', 'throw', 'timer'],
    'Observable');
confirmProps(Observable.prototype, ['defaultIfEmpty', 'do', 'filter',
    'map', 'mergeAll', 'take', 'takeUntil'
], 'Observable.prototype');

const UNHANDLED_LOGIC_ERROR = 'UNHANDLED_LOGIC_ERROR';
const NODE_ENV = process.env.NODE_ENV;

const debug = ( /* ...args */ ) => {};

/**
 * [createLogicAction$ description]
 * @param  {Object}     options.action   当前action
 * @param  {Object}     options.logic    当前logic
 * @param  {Object}     options.store    redux store
 * @param  {Object}     options.deps     createLogicMiddleware的第二个参数
 * @param  {Rx.Subject} options.cancel$  取消Logic执行的订阅对象
 * @param  {Rx.Subject} options.monitor$ 全局可订阅对象
 * @return {Rx.Observable}
 */
export default function createLogicAction$({ action, logic, store, deps, cancel$, monitor$ }) {

    //  reduxStore.getState()
    const { getState } = store;

    //  从当前logic中取得相关配置参数
    const {
        name,
        warnTimeout,
        process: processFn,
        processOptions: {
            dispatchReturn,
            dispatchMultiple,
            successType,
            failType
        }
    } = logic;

    //  当前Logic的拦截器
    const intercept = logic.validate || logic.transform;

    debug('createLogicAction$', name, action);

    //  开始本次action的执行
    monitor$.next({ action, name, op: 'begin' });

    /**
        1.当前action发生改变
        2.在validate/transform中调用allow
        3.无效的action type
        4.action被取消
        interceptComplete都会变成true, 标记拦截器处理完成
     **/
    let interceptComplete = false;

    //  https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-take
    const logicAction$ = Observable.create(logicActionObs => {
            //  创建一个主题(只发出一个值), 用来订阅`取消Logic执行的订阅对象`, 在取消本次action后, 通知`取消Logic执行的订阅对象`
            const cancelled$ = (new Subject()).take(1);
            cancel$.subscribe(cancelled$);
            cancelled$
                .subscribe(
                    () => {
                        //  确保cancel不会被调用2次(在createLogicMiddle中追加的pending只会被减一次)
                        if (!interceptComplete) {
                            monitor$.next({ action, name, op: 'cancelled' });
                        } else {
                            monitor$.next({ action, name, op: 'dispCancelled' });
                        }
                    }
                );

            //  如果改Logic不是一个持续性的, 且没有在warnTimeout / 1000秒内调用done(warnTimeout > 0), 就给出异常提示
            if (NODE_ENV !== 'production' && warnTimeout) {
                Observable.timer(warnTimeout)
                    //  https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-takeUntil
                    //  https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-defaultIfEmpty
                    .takeUntil(cancelled$.defaultIfEmpty(true))
                    .do(() => {
                        console.error(`warning: logic (${name}) is still running after ${warnTimeout / 1000}s, forget to call done()? For non-ending logic, set warnTimeout: 0`);
                    })
                    .subscribe();
            }

            const dispatch$ = (new Subject())
                .mergeAll()
                .takeUntil(cancel$);

            dispatch$
                /**
                    .do({
                        nextOrObserver: mapToActionAndDispatch,
                        error: mapErrorToActionAndDispatch
                    })
                    这里省略了nextOrObserver和error
                    https://cn.rx.js.org/class/es6/Observable.js~Observable.html#instance-method-do
                 **/
                .do(
                    mapToActionAndDispatch,
                    mapErrorToActionAndDispatch
                )
                .subscribe({
                    error: ( /* err */ ) => {
                        //  在发生异常后, 终止本次acion, 并且取消订阅cancelled$
                        monitor$.next({ action, name, op: 'end' });
                        cancelled$.complete();
                        cancelled$.unsubscribe();
                    },
                    complete: () => {
                        //  本次action处理完成
                        monitor$.next({ action, name, op: 'end' });
                        cancelled$.complete();
                        cancelled$.unsubscribe();
                    }
                });

            //  触发redux里面的action
            function storeDispatch(act) {
                monitor$.next({ action, dispAction: act, op: 'dispatch' });
                return store.dispatch(act);
            }

            /**
             * 适配不同情况的action, 组装后如果是一个有效的redux action, 就调用reduxStore.dispatch
             * @param  {Object} actionOrValue
             */
            function mapToActionAndDispatch(actionOrValue) {
                /**
                    let act;
                    if (isInterceptAction(actionOrValue)) {
                        act = unwrapInterceptAction(actionOrValue);
                    } else {
                        if (successType) {
                            act = mapToAction(successType, actionOrValue, false);
                        } else {
                            act = actionOrValue;
                        }
                    }
                    把下面的代码拆成上面的样子, 大概做了下面几件事情:
                    判断是不是一个拦截器, 如果是就把之前包装的拦截器解包
                    判断processOptions.successType是否存在, 存在就调用mapToAction, 拼出一个新的redux action, 调用reduxSrore.dispatch
                    否则就直接使用actionOrValue
                **/
                const act = (isInterceptAction(actionOrValue)) ? 
                unwrapInterceptAction(actionOrValue) : (successType) ? 
                mapToAction(successType, actionOrValue, false) : actionOrValue;

                if (act) {
                    storeDispatch(act);
                }
            }

            /**
             * 根据actionOrValue的类型来组装可以被reduxStore.dispatch调用的action
             * @param  {any} actionOrValue
             * @return {Object}
             */
            function mapErrorToActionAndDispatch(actionOrValue) {
                //  拦截器类型的直接调用触发__interceptAction
                if (isInterceptAction(actionOrValue)) {
                    const interceptAction = unwrapInterceptAction(actionOrValue);
                    return storeDispatch(interceptAction);
                }

                //  判断Logic中的processOptions里有没有failType
                if (failType) {
                    //  如果有failType, 组装一个新的redux action并触发
                    const act = mapToAction(failType, actionOrValue, true);
                    if (act) {
                        return storeDispatch(act);
                    }
                    return;
                }

                //  actionOrValue本身就是一个异常
                if (actionOrValue instanceof Error) {
                    const act =
                        //  actionOrValue本身包含type, 直接调用redux.dispatch(actionOrValue)
                        //  否则包装出一个redux action(type为UNHANDLED_LOGIC_ERROR), 在调用redux.dispatch
                        (actionOrValue.type) ? actionOrValue :
                        {
                            type: UNHANDLED_LOGIC_ERROR,
                            payload: actionOrValue,
                            error: true
                        };
                    return storeDispatch(act);
                }

                //  actionOrValue是一个plain object或一个函数(action creator)
                const typeOfValue = typeof actionOrValue;
                if (actionOrValue && (typeOfValue === 'object' || typeOfValue === 'function')) {
                    return storeDispatch(actionOrValue);
                }

                //  非异常/函数/plain object的情况
                storeDispatch({
                    type: UNHANDLED_LOGIC_ERROR,
                    payload: actionOrValue,
                    error: true
                });
            }

            /**
             * 
             * @param  {String|Function} type       redux action type
             * @param  {Object} payload             redux payload
             * @param  {Error|Unfdeined} err        error
             * @return {Object}
             */
            function mapToAction(type, payload, err) {
                //  action type本身是一个action creator, 直接执行type
                if (typeof type === 'function') {
                    return type(payload);
                }
                //  包装出一个有效的redux action
                const act = { type, payload };
                if (err) { act.error = true; }
                return act;
            }

            // allowMore is now deprecated in favor of variable process arity
            // which sets processOptions.dispatchMultiple = true then
            // expects done() cb to be called to end
            // Might still be needed for internal use so keeping it for now
            const DispatchDefaults = {
                allowMore: false
            };

            /**
             * 触发
             * @param  {[type]} act     [description]
             * @param  {[type]} options [description]
             * @return {[type]}         [description]
             */
            function dispatch(act, options = DispatchDefaults) {
                const { allowMore } = applyDispatchDefaults(options);
                //  action !== undefined
                if (typeof act !== 'undefined') {
                    /**
                        let action;
                        if (isObservable(act)) {
                            action = act;
                        } else if (isPromise(act)) {
                            action = Observable.fromPromise(act);
                        } else if (act instanceof Error) {
                            action = Observable.throw(act);
                        } else {
                            action = Observable.of(act);
                        }
                        dispatch$.next(action);

                        https://cn.rx.js.org/class/es6/MiscJSDoc.js~ObserverDoc.html#instance-method-next
                     **/
                    dispatch$.next(
                        (isObservable(act)) ? act :
                        (isPromise(act)) ? Observable.fromPromise(act) :
                        (act instanceof Error) ? Observable.throw(act) :
                        Observable.of(act)
                    );
                }
                if (!(dispatchMultiple || allowMore)) {
                   dispatch$.complete();
                }
                return act;
            }

            function applyDispatchDefaults(options) {
                return {
                    ...DispatchDefaults,
                    ...options
                };
            }

            //  拼装createLogic中相关钩子函数(validate/tranform/process)中的第一个参数
            const depObj = {
                ...deps,
                cancelled$,
                ctx: {}, // 在不同钩子中共享数据
                getState,
                action
            };

            function shouldDispatch(act, useDispatch) {
                //  新的action为空
                if (!act) { return false; }
                //  在触发另外一个action之前, 确保触发的是一个新的action
                if (useDispatch === 'auto') {
                    return (act.type !== action.type);
                }
                //  否则根据useDispatch是否为空, 返回
                return (useDispatch);
            }

            const AllowRejectNextDefaults = {
                useDispatch: 'auto'
            };

            function applyAllowRejectNextDefaults(options) {
                return {
                    ...AllowRejectNextDefaults,
                    ...options
                };
            }

            //  拦截器(validate/tranform)里的allow或next
            function allow(act, options = AllowRejectNextDefaults) {
                handleNextOrDispatch(true, act, options);
            }
            function reject(act, options = AllowRejectNextDefaults) {
                handleNextOrDispatch(false, act, options);
            }

            //  完成本次action, 在createLogic中的process最后调用
            function done() {
                dispatch$.complete();
            }

            /**
             * 对当前拦截器类型action(validate/transform)做一次包装, 方便后面判断
             * @param  {Object} act 当前action
             * @return {Object}
             */
            function wrapActionForIntercept(act) {
                if (!act) { return act; }
                return {
                    __interceptAction: act
                };
            }

            /**
             * 判断传入的action是否为拦截器类型的
             * @param  {Object}  act 当前action
             * @return {Boolean}
             */
            function isInterceptAction(act) {
                return act && act.__interceptAction;
            }

            /**
             * 对拦截器执行解包
             * @param  {Object}  act 当前action
             * @return {Object}      redux action
             */
            function unwrapInterceptAction(act) {
                return act.__interceptAction;
            }

            /**
             * 拦截器(validate/tranform)里的allow、reject实现, 触发新的redux action
             * @param  {Boolean} shouldProcess 是否执行process
             * @param  {Object} act            新的redux action
             * @param  {Object} options
             */
            function handleNextOrDispatch(shouldProcess, act, options) {
                const { useDispatch } = applyAllowRejectNextDefaults(options);
                //  判断是否应该触发传入的redux action
                if (shouldDispatch(act, useDispatch)) {
                    monitor$.next({ action, dispAction: act, name, shouldProcess, op: 'nextDisp' });
                    interceptComplete = true;
                    dispatch(wrapActionForIntercept(act), { allowMore: true }); // will be completed later
                    logicActionObs.complete(); // dispatched action, so no next(act)
                } else { // normal next
                    if (act) {
                        monitor$.next({ action, nextAction: act, name, shouldProcess, op: 'next' });
                    } else {
                        //  无效的action, 直接结束本次拦截器
                        monitor$.next({ action, name, shouldProcess, op: 'filtered' });
                        interceptComplete = true;
                    }
                    postIfDefinedOrComplete(act, logicActionObs);
                }

                //  执行Logic中的process回调
                if (shouldProcess) {
                    //  组织depObj的action参数
                    depObj.action = act || action;
                    try {
                        const retValue = processFn(depObj, dispatch, done);
                        /**
                            如果在createLogic指定了processOption.dispatchReturn为true, 并且prcess执行完之后返回有效的值
                            就再把返回值作为一个新的redux action进行触发
                            否则直接结束dispatch$这个Rx.Subject
                            
                            执行process, 并且接收返回值
                            判断processOption.dispatchReturn
                                成立: 判断返回值是否有效

                                    有效: dispatch -> mapToActionAndDispatch
                                        mapToActionAndDispatch返回一个有效的action:
                                            继续reduxStore.dispatch(mapToActionAndDispatch(retValue))

                                    无效: dispatch$.complete -> monitor$.next({ action, name, op: 'end' }); cancelled$.complete(); cancelled$.unsubscribe();
                        **/
                        if (dispatchReturn) {
                            if (typeof retValue === 'undefined') {
                                dispatch$.complete();
                            } else {
                                dispatch(retValue);
                            }
                        }
                    } catch (err) {
                        console.error(`unhandled exception in logic named: ${name}`, err);
                        //  执行process的过程中发生异常
                        dispatch(Observable.throw(err));
                    }
                } else {
                    //  传入的act是一个空值, 或者和当前的type相同, 或者useDispatch不成立
                    dispatch$.complete();
                }
            }

            /**
             * 在本次拦截器之后执行
             * @param  {Object} act       新的action
             * @param  {Rx.Subject} act$  当前action对应的Observable对象
             */
            function postIfDefinedOrComplete(act, act$) {
                //  如果新的action存在, 执行新的action
                if (act) {
                    act$.next(act);
                }
                interceptComplete = true;
                act$.complete();
            }

            //  开始本次action的执行
            function start() {
                intercept(depObj, allow, reject);
            }

            start();
        })
        .takeUntil(cancel$)
        //  规定logicAction$值发出一个值就完成
        .take(1);

    return logicAction$;
}
