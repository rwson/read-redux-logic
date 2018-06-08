const allowedOptions = [
    'name',
    'type',
    'cancelType',
    'latest',
    'debounce',
    'throttle',
    'validate',
    'transform',
    'process',
    'processOptions',
    'warnTimeout'
];

const allowedProcessOptions = [
    'dispatchReturn',
    'dispatchMultiple',
    'successType',
    'failType',
];

const NODE_ENV = process.env.NODE_ENV;

const defaultOptions = {
    warnTimeout: 60000,
    latest: false,
    debounce: 0,
    throttle: 0,
};

const globallyConfigurableOptions = ['warnTimeout'];

/**
   Configure the default `createLogic` options. Note that changing these values
   will not affect `Logic` instances that have already been instantiated.

   @param {object}  options object defining default values to be used when creating `Logic`
     instances. The following options may be set globally:
        - warnTimeout

     See the `createLogic` API documentation for a description of these options.

   @returns {undefined}

   @example

   ```
   import { configureLogic, createLogic } from 'redux-logic';

   configureLogic({ warnTimeout: 10000 })

   // These will both timeout after 10 seconds instead of the library default of
   // 1 minute.
   const logicOne = createLogic({
      type: 'ACTION_ONE',
   })
   const logicTwo = createLogic({
      type: 'ACTION_TWO',
   })
   ```
 */
export const configureLogic = (options = {}) => {
    const invalidOptions = getInvalidOptions(options, globallyConfigurableOptions);
    if (invalidOptions.length) {
        throw new Error(`${invalidOptions} are not globally configurable options.`);
    }

    Object.keys(options)
        .forEach((option) => { defaultOptions[option] = options[option]; });
};

/**
   Validate and augment logic object to be used in logicMiddleware.
   The returned object has the same structure as the supplied
   logicOptions argument but it will have been validated and defaults
   will be applied

   @param {object} logicOptions object defining logic operation
   @param {string} logicOptions.name optional string name, defaults
     to generated name from type and idx
   @param {string | regex | function | array} logicOptions.type action
     type(s) that this logic is used for. A string '*' indicates that
     it applies to all types, otherwise strings are used for exact match.
     A regex can also be used to match. If a function is supplied like
     a redux-actions action function, then it will use call its toString()
     method to get the associated action type. An array of any of these
     can be supplied to extend match to more types.
   @param {string | regex | function | array} logicOptions.cancelType
     action type(s) that will cause a cancellation. String, regex, fn,
     array are used similar to how the logicOptions.type works.
     Cancellation will automatically prevent dispatches from being used
     regardless of when the original logic finishes. Additionally a
     cancellation$ observable is available to logic to detect
     cancellation and perform any manual cleanup.
   @param {boolean} logicOptions.latest enables takeLatest which cancels
     previous when a newer one comes in, default false
   @param {number} logicOptions.debounce milliseconds to perform
     debouncing, cannot be used with latest, default 0 (disabled)
   @param {number} logicOptions.throttle milliseconds to perform
     throttling, cannot be used with latest, default 0 (disabled)
   @param {function} logicOptions.validate hook that will be executed
     before an action has been sent to other logic, middleware, and the
     reducers. Must call one of the provided callback functions allow or
     reject with an action to signal completion. Expected to be called
     exactly once. Pass undefined as an object to forward nothing.
     Calling reject prevents process hook from being run. Defaults to
     an identity fn which allows the original action.
   @param {function} logicOptions.transform hook that will be executed
     before an action has been sent to other logic, middleware, and the
     reducers. This is an alias for the validate hook. Call the
     provided callback function `next` (or `reject`) to
     signal completion. Expected to be called exactly once. Pass
     undefined as an object to forward nothing. Defaults to an identity
     transform which forwards the original action.
   @param {function} logicOptions.process hook that will be invoked
     after the original action (or that returned by validate/transform
     step) has been forwarded to other logic, middleware, and reducers.
     This hook will not be run if the validate/transform hook called
     reject. This hook is ideal for any additional processing or async
     fetching. The fn signature is `process(deps, ?dispatch, ?done)`
     where dispatch and done are optional and if included in the
     the signature will change the dispatch mode:
     1. Neither dispatch, nor done - dispatches the returned/resolved val
     2. Only dispatch - single dispatch mode, call dispatch exactly once (deprecated)
     3. Both dispatch and done - multi-dispatch mode, call done when finished
     Dispatch may be called with undefined when nothing needs to be
     dispatched. Multiple dispatches may be made if including the done or
     simply by dispatching an observable.
     More details on dispatching modes are in the advanced API docs
   @param {object} logicOptions.processOptions options influencing
     process hook, default {}
   @param {boolean} logicOptions.processOptions.dispatchReturn dispatch
     the return value or resolved/next promise/observable, default is
     false when dispatch is included in process fn signature
   @param {boolean} logicOptions.processOptions.dispatchMultiple
     multi-dispatch mode is enabled and continues until done is called
     or cancelled. The default is false unless the done cb is included
     in the process fn signature.
   @param {string|function} logicOptions.processOptions.successType
     action type or action creator fn, use value as payload
   @param {string|function} logicOptions.processOptions.failType
     action type or action creator fn, use value as payload
   @param {number} logicOptions.warnTimeout In non-production environment
     a console.error message will be logged if logic doesn't complete
     before this timeout in ms fires. Set to 0 to disable. Defaults to
     60000 (one minute)
   @returns {object} validated logic object which can be used in
     logicMiddleware contains the same properties as logicOptions but
     has defaults applied.
 */

/**
 * 创建一个Logic对象
 * @param  {Object} logicOptions
 *         @param  {String}     logicOptions.name           可选值, 主要用于Logic中的异常提示, 可选值
 *         @param  {String}     logicOptions.type           触发当前Logic的redux action type
 *         @param  {String}     logicOptions.cancelType     取消执行当前Logic的redux action type
 *         @param  {Boolean}    logicOptions.latest         是否只获取最后一次的结果,类似redux-saga中的takeLatest effect
 *         @param  {Number}     logicOptions.debounce       函数去抖配置, 单位为毫秒
 *         @param  {Object}     logicOptions.throttle       函数节流配置, 单位为毫秒
 *         @param  {Function}   logicOptions.validate       在执行process之前的一个钩子, 可以对当前action执行一些操作
 *         @param  {Function}   logicOptions.transform      validate的一个别名, validate和transform只需指定一个即可
 *         @param  {Function}   logicOptions.process        当前redux action type对应的处理逻辑(发起异步请求, 在异步请求返回成功之后触发新的redux action)
 *         @param  {Object}     logicOptions.processOptions process中需要的一些配置
 *         @param  {Number}     logicOptions.warnTimeout    超时警告时间, 默认60秒, 需要在process中手动调用done来终止这个Logic, 如果是一个持续性的Logic, warnTimeout需要设置成0
 * @return {Object}              创建出来的Logic
 */
export default function createLogic(logicOptions = {}) {
    //  无效配置项验证, 把无效的配置项键名放数组返回
    const invalidOptions = getInvalidOptions(logicOptions, allowedOptions);
    if (invalidOptions.length) {
        throw new Error(`unknown or misspelled option(s): ${invalidOptions}`);
    }

    //  name, type, cancelType, validate, transform都从传入的logicOptions里面获取
    //  如果其他配置项没有在logicOptions中声明, 就从默认配置中获取或者给一个默认值
    const {
        name,
        type,
        cancelType,
        warnTimeout = defaultOptions.warnTimeout,
        latest = defaultOptions.latest,
        debounce = defaultOptions.debounce,
        throttle = defaultOptions.throttle,
        validate,
        transform,
        process = emptyProcess,
        processOptions = {}
    } = logicOptions;

    //  type必传
    if (!type) {
        throw new Error('type is required, use \'*\' to match all actions');
    }

    //  validate和tranform只能同时指定一个
    if (validate && transform) {
        throw new Error('logic cannot define both the validate and transform hooks they are aliases');
    }

    //  warnTimeout需要放在processOptions同级
    if (typeof processOptions.warnTimeout !== 'undefined') {
        throw new Error('warnTimeout is a top level createLogic option, not a processOptions option');
    }

    //  获取processOptions中的无效配置项
    const invalidProcessOptions = getInvalidOptions(processOptions, allowedProcessOptions);
    if (invalidProcessOptions.length) {
        throw new Error(`unknown or misspelled processOption(s): ${invalidProcessOptions}`);
    }

    //  如果validate和transform都没传入,就用默认的, 否则就用传入的validate
    const validateDefaulted = (!validate && !transform) ?
        identityValidation :
        validate;

    //  如果在processOptions里面指定了dispatchMultiple, warnTimeout应该是0
    if (NODE_ENV !== 'production' &&
        typeof processOptions.dispatchMultiple !== 'undefined' &&
        warnTimeout !== 0) {
        console.error(`warning: in logic for type(s): ${type} - dispatchMultiple is always true in next version. For non-ending logic, set warnTimeout to 0`);
    }

    /**
        根据process.length可以获取传入的process对应的处理函数中的形参个数
        从而确定processOption中的一些默认值

        const fn = function(arg1, agr2) {};
        console.log(fn.length);  -> 2

        const fn = function(arg1, agr2, arg3) {};
        console.log(fn.length); -> 3
    **/
    switch (process.length) {
        //  如果没有或只有一个形参没有传入且dispatchReturn没有在processOptions传入, 就把它设置成true
        case 0:
        case 1:
            setIfUndefined(processOptions, 'dispatchReturn', true);
            break;

        //  两个形参(single-dispatch模式[已废弃])
        case 2:
            if (NODE_ENV !== 'production' &&
                !processOptions.dispatchMultiple &&
                warnTimeout !== 0) {
                console.error(`warning: in logic for type(s): ${type} - single-dispatch mode is deprecated, call done when finished dispatching. For non-ending logic, set warnTimeout: 0`);
            }
            break;

        /**
            3个形参及更多, 认为是multi-dispatch模式
            processOptions.dispatchMultiple = processOptions === undefined ? true : processOptions.dispatchMultiple
        **/
        case 3:
        default:
            setIfUndefined(processOptions, 'dispatchMultiple', true);
            break;
    }

    //  返回处理好的对象
    return {
        name: typeToStrFns(name),
        type: typeToStrFns(type),
        cancelType: typeToStrFns(cancelType),
        latest,
        debounce,
        throttle,
        validate: validateDefaulted,
        transform,
        process,
        processOptions,
        warnTimeout
    };
}

function getInvalidOptions(options, validOptions) {
    return Object.keys(options)
        .filter(k => validOptions.indexOf(k) === -1);
}

/* if type is a fn call toString() to get type, redux-actions
  if array, then check members */
/**
 * 如果是数组形式就针对数组的每一项都调用typeToStrFns, 并返回一个新数组
 * 如果是函数形式就返回函数体的字符串形式
 * 其它直接返回
 * @param  {any} type
 * @return {String|any}
 */
function typeToStrFns(type) {
    if (Array.isArray(type)) { return type.map(x => typeToStrFns(x)); }
    return (typeof type === 'function') ?
        type.toString() :
        type;
}

function identityValidation({ action }, allow /* , reject */ ) {
    allow(action);
}

function emptyProcess(_, dispatch, done) {
    dispatch();
    done();
}

function setIfUndefined(obj, propName, propValue) {
    if (typeof obj[propName] === 'undefined') {
        // eslint-disable-next-line no-param-reassign
        obj[propName] = propValue;
    }
}
