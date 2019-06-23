import Module from './module'
import { assert, forEachValue } from '../util'

//ModuleCollection代表模块实例（Module）的集合
export default class ModuleCollection {
  constructor (rawRootModule) {
    // register root module (Vuex.Store options)
    // 将 new Vuex.Store 传入的配置项作为参数 rawRootModule 传入
    // 即 state,dispatch,mutation,getter,modules 组成的对象
    this.register([], rawRootModule, false)
  }
  // 根据传入的 path （数组），递归的遍历，不断的从模块的子模块中找
  // 直到 path 遍历完毕，找到这个 path 数组最后一个元素对应的模块
  // 即根据 path 数组找对对应的模块
  get (path) {
    return path.reduce((module, key) => {
      return module.getChild(key)
    }, this.root)
  }

  // 当 namespaced 为 true 就将当前模块的属性名拼接到整个 namespace 组成的字符串中
  // 并且这个模块下面所有的 actions/mutations/getters 都会加上 namespace 前缀
  getNamespace (path) {
    let module = this.root
    return path.reduce((namespace, key) => {
      module = module.getChild(key)
      return namespace + (module.namespaced ? key + '/' : '')
    }, '')
  }

  update (rawRootModule) {
    update([], this.root, rawRootModule)
  }

  // 根据配置项生成 ModuleCollection 实例，即所有模块集合
  /**一般一个 Vuex 实例只有一个模块集合，一个模块集合有多个模块实例组成**/
  // runtime 为 true 时，代表动态注入的模块，初始化时传入 false
  register (path, rawModule, runtime = true) {
    if (process.env.NODE_ENV !== 'production') {
      assertRawModule(path, rawModule)
    }
    // 实例化 Modules 对象，传入当前 Module 的配置项
    const newModule = new Module(rawModule, runtime)
    if (path.length === 0) {
      // 定义唯一的一个实例属性 root，指向根 module 实例
      this.root = newModule
    } else {
        // 通过 path 参数，找到当前模块的父模块
      const parent = this.get(path.slice(0, -1))
        // 给当前模块的父模块的 _children 属性添加当前模块
        // 即注册子模块
      parent.addChild(path[path.length - 1], newModule)
    }

    // 递归注册当前 module 的子 modules
    // register nested modules
    if (rawModule.modules) {
      forEachValue(rawModule.modules, (rawChildModule, key) => {
        // 将 path 参数并且当前模块子模块的属性名，传入递归 register 函数中
        // 作为模块的前缀（命名空间）
        this.register(path.concat(key), rawChildModule, runtime)
      })
    }
  }

  unregister (path) {
    const parent = this.get(path.slice(0, -1))
    const key = path[path.length - 1]
    if (!parent.getChild(key).runtime) return

    parent.removeChild(key)
  }
}

function update (path, targetModule, newModule) {
  if (process.env.NODE_ENV !== 'production') {
    assertRawModule(path, newModule)
  }

  // update target module
  targetModule.update(newModule)

  // update nested modules
  if (newModule.modules) {
    for (const key in newModule.modules) {
      if (!targetModule.getChild(key)) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[vuex] trying to add a new module '${key}' on hot reloading, ` +
            'manual reload is needed'
          )
        }
        return
      }
      update(
        path.concat(key),
        targetModule.getChild(key),
        newModule.modules[key]
      )
    }
  }
}

const functionAssert = {
  assert: value => typeof value === 'function',
  expected: 'function'
}

const objectAssert = {
  assert: value => typeof value === 'function' ||
    (typeof value === 'object' && typeof value.handler === 'function'),
  expected: 'function or object with "handler" function'
}

const assertTypes = {
  getters: functionAssert,
  mutations: functionAssert,
  actions: objectAssert
}

function assertRawModule (path, rawModule) {
  Object.keys(assertTypes).forEach(key => {
    if (!rawModule[key]) return

    const assertOptions = assertTypes[key]

    forEachValue(rawModule[key], (value, type) => {
      assert(
        assertOptions.assert(value),
        makeAssertionMessage(path, key, type, value, assertOptions.expected)
      )
    })
  })
}

function makeAssertionMessage (path, key, type, value, expected) {
  let buf = `${key} should be ${expected} but "${key}.${type}"`
  if (path.length > 0) {
    buf += ` in module "${path.join('.')}"`
  }
  buf += ` is ${JSON.stringify(value)}.`
  return buf
}
