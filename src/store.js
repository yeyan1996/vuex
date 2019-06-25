import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert } from './util'

let Vue // bind on install

export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    if (process.env.NODE_ENV !== 'production') {
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // store internal state
    this._committing = false
    this._actions = Object.create(null)
    this._actionSubscribers = []
    this._mutations = Object.create(null)
    this._wrappedGetters = Object.create(null)
      // 创建根 modules，初始化父子 modules 关系（树）
    this._modules = new ModuleCollection(options)
    this._modulesNamespaceMap = Object.create(null)
    this._subscribers = []
    this._watcherVM = new Vue()

    // bind commit and dispatch to self
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict

    const state = this._modules.root.state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    // 初始化当前模块和所有子模块，根据命名空间注册 state,actions,mutations,getters，并且提供访问当前模块的便捷方法（local）
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
     /**
      * 新建一个vm实例保存state，在computed属性中保存getters，通过watch观察state，保证都使用commit修改state
      **/
    resetStoreVM(this, state)

    // 安装插件
    // apply plugins
    plugins.forEach(plugin => plugin(this))

    const useDevtools = options.devtools !== undefined ? options.devtools : Vue.config.devtools
    if (useDevtools) {
      // vuex 默认会添加 vue-devtools 插件
      devtoolPlugin(this)
    }
  }

  // 将 store.state 即 rootState 代理到之前声明的 vm 实例中的 $$state 中
  get state () {
    return this._vm._data.$$state
  }

  set state (v) {
    if (process.env.NODE_ENV !== 'production') {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  commit (_type, _payload, _options) {
    // check object-style commit
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        // handler 同样包裹了一层函数 wrappedMutation ，在内部会加入当前的 local 对象，再合并 payload
        // 执行这个 mutation
        handler(payload)
      })
    })
    //调用订阅者的回调函数（默认会在devtools会记录这个mutation名字和当前的state状态）
    this._subscribers.forEach(sub => sub(mutation, this.state))

    if (
      process.env.NODE_ENV !== 'production' &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    /** entry是一个 wrappedAction，执行函数会在开发者定义的 action 上包裹一层函数，通过 call 传入 ctx 对象和 payload**/
    // 同时保证 wrappedAction 会保证 action 是一个 promise
      // 如果定义多个重名的 action 并且没有加命名空间，则 entry 长度 > 1
    const entry = this._actions[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    // 执行 action 的订阅者（前置钩子）
    try {
      this._actionSubscribers
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    return result.then(res => {
      try {
          // 执行 action 的订阅者（后置钩子）
        this._actionSubscribers
          .filter(sub => sub.after)
          .forEach(sub => sub.after(action, this.state))
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[vuex] error in after action subscribers: `)
          console.error(e)
        }
      }
      return res
    })
  }

  // 添加一个 mutation 订阅者,返回一个取消订阅的函数
  subscribe (fn) {
    return genericSubscribe(fn, this._subscribers)
  }
  // 添加一个 action 订阅者
  subscribeAction (fn) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers)
  }

  watch (getter, cb, options) {
    if (process.env.NODE_ENV !== 'production') {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  // 用于时间旅行
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  //动态注入vuex模块
  registerModule (path, rawModule, options = {}) {
    //保证path是一个数组（符合vuex安装的规则）
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }
    // 调用 moduleCollection 实例的 register 方法，根据 path 动态注册模块
    this._modules.register(path, rawModule)
      //初始化
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
      //重新重置所有的state（实例化一个vm存储state和getters）
    resetStoreVM(this, this.state)
  }

  // 动态卸载模块
  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    // 通过 path 从对应的模块中通过 delete 操作符删除属性
    this._modules.unregister(path)
    this._withCommit(() => {
      const parentState = getNestedState(this.state, path.slice(0, -1))
        // 从 state 中删除该模块
      Vue.delete(parentState, path[path.length - 1])
    })
      // 重置模块
    resetStore(this)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  //通过commit的方式修改state
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

//添加一个订阅者返回一个取消订阅的函数
function genericSubscribe (fn, subs) {
  if (subs.indexOf(fn) < 0) {
    subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

// 重新初始化模块
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
    // 保留了重置前的所有状态（包括模块）
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  // 定义 store 的 getters 属性
  store.getters = {}
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
      // fn 是 wrappedGetters 对象的属性值，即 wrappedGetter 函数（497）
      /**将 wrappedGetters 对象上所有的 getter 函数，作为内部 vm 实例的 computed 属性**/
      // 这里传入了全局的 store 对象，因为 getter 的 3，4 参数需要依赖 store 对象（store.state，store.getters）
    computed[key] = () => fn(store)
    // 定义 store.getters 属性，使得能直接通过 store.getters.< getter 名> 访问对应的 getter
    // key 为含有命名空间的完整路径
    Object.defineProperty(store.getters, key, {
        // 访问 store.getters 最终会指向 vm 实例对应的 computed 属性，同时触发计算返回结果值
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  Vue.config.silent = true
  store._vm = new Vue({
    data: {
      //state为store.state即rootState
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
    // 是否开启 vuex 的 strict 模式，禁止 commit 以外的方法修改 state
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

// module 为 module 实例，第一次传入根模块的 module 实例
// path 初始化时，传入一个空数组，之后若有命名空间会转为命名空间组成的数组
function installModule (store, rootState,path, module, hot) {
  const isRoot = !path.length // 判断是否是根模块

    // 根据 path 数组获取命名前缀，根模块为空字符串
    // 设置了 namespaced 的模块会根据嵌套的层级拼接（a/b/c/）
  const namespace = store._modules.getNamespace(path)

    // register in namespace map
    // 生成 _modulesNamespaceMap 对象，存放 namespaced 为 true 的模块
    // 属性名是所有的父级 module 名 +  '/'，值为当前注册的 module 实例
    // 通过加上父级模块的路径，保证了每个模块都有自己的命名空间，防止名字相同的 getter/actions/mutations 命名冲突
  if (module.namespaced) {
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
    /**添加当前模块，作为父模块的 state 对象中的属性，在 state 中建立父子关系**/
  if (!isRoot && !hot) {
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      // 在父模块的 state 属性中添加当前模块，属性名是当前模块名，值是 state 对象
        // Vuex 之所以这么做可能是因为需要让所有的模块状态都保存在 state 中
        // 使得在重置模块时能够通过保留 state 从而保留所有的模块依赖关系
      Vue.set(parentState, moduleName, module.state)
    })
  }

    /**给当前模块添加 context 属性，即 action 的第一个参数 ctx **/
    // ctx 中的 dispatch 会添加当前模块的命名空间再执行全局的 dispatch 去 _actions 中找到对应的 action
    // local 返回的是一个含有 dispatch,commit,getters,state 的对象，即 ctx
  const local = module.context = makeLocalContext(store, namespace, path)

  module.forEachMutation((mutation, key) => {
    // mutation 是 mutations 中定义的函数，key 为这个 mutation 函数的 key
    const namespacedType = namespace + key
      // 给 store 的 _mutations 对象添加当前模块包含的所有 mutations
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key // 完整的 getter 名
    registerGetter(store, namespacedType, getter, local)
  })

  module.forEachChild((child, key) => {
    //递归注册子模块，建立 module 树，并且给 path 数组推入当前命名空间（字符串）
      // 此时所有的子模块中的 state，actions，mutations，getters 都被注册完毕
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
// 使得声明了 namespace 的模块中的 actions dispatch 时不需要加上命名空间，自动作用与当前模块
// 传入 namespace (a/b/c/)
// 如果没有声明 namespaced，namespace 为一个空字符串
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

    // local 为 action 中第一个 ctx 参数
  const local = {
    // 没有显式的声明 namespace 则使用普通的 dispatch
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        /**如果定义了 namespace:true 则会自动在 type 前加上模块的命名空间（a/b/c/ + type）**/
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
    // 定义 local.getters 和 local.state
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
          // 生成上下文的 getters 对象
          // 允许在 module 中通过 ctx.getters ，使得访问当前 module 的 getter 不需要添加命名空间
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

// 定义 ctx.getter 对象
function makeLocalGetters (store, namespace) {
  const gettersProxy = {}

  const splitPos = namespace.length
    // store.getters 保存了所有 getters，并且同名的 getters 会添加命名空间
  Object.keys(store.getters).forEach(type => {
    // skip if the target getter is not match this namespace
    if (type.slice(0, splitPos) !== namespace) return

    // extract local getter type
      // 根据 type 获取 localType 名
      // type(a/b/c/getter1) = splitPos(a/b/c/) + localType(getter1)
    const localType = type.slice(splitPos)

    // Add a port to the getters proxy.
    // Define as getter property because
    // we do not want to evaluate the getters in this time.
    Object.defineProperty(gettersProxy, localType, {
      // 访问localType实际上映射到 store.getters 中的type
        /**即访问 local.getter 最终会拼上命名空间从 store.getters 找**/
      get: () => store.getters[type],
      enumerable: true
    })
  })

  return gettersProxy
}

function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
    //mutations对象中的mutation实际上是一个数组，当有重复名字的mutation存在时，依次执行
  entry.push(function wrappedMutationHandler (payload) {
    // handler 为 mutation 函数，并且让这个 mutation 能够不用命名前缀访问当前模块的state
    handler.call(store, local.state, payload)
  })
}

// type 也是包含命名空间的完整路径
function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
    // action 会被 wrappedActionHandler 包裹一层，每当 dispatch 执行一个 action 时
    // 都会通过 wrappedActionHandler 将 action 包裹为一个 promise，并且传入 ctx 中的 dispatch 等方法
  entry.push(function wrappedActionHandler (payload, cb) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      // rootGetters 为 store 中的根getters
      rootGetters: store.getters,
      rootState: store.state
    }, payload, cb)
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

function registerGetter (store, type, rawGetter, local) {
  //getter不能有相同命名
  if (store._wrappedGetters[type]) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
    /** _wrappedGetters 和 store.getters 的区别在于，前者的值是一个函数，后者的值是函数计算后的结果**/
    // 当执行里面的 getter 函数时，会传入 local 对象来计算出最终值
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
        // 传入 getter 的 4 个参数
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

// 通过 watch 整个 vm 实例的 state 对齐 setter 进行拦截
// 来保证在开发环境下，对 state 的修改都是通过commit，不能直接修改 state 的属性
function enableStrictMode (store) {
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (process.env.NODE_ENV !== 'production') {
      //当committing为false时会报错
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

function getNestedState (state, path) {
  return path.length
    ? path.reduce((state, key) => state[key], state)
    : state
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (process.env.NODE_ENV !== 'production') {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  applyMixin(Vue)
}
