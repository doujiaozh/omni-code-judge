/**
 * Bad-code sample — deliberately collects every red card in the book:
 * eval, innerHTML, hardcoded credentials, exec injection, god class,
 * global mutable state, deep nesting, `any` everywhere and zero tests.
 *
 * Run:  node bin/judge.js examples/bad-code.ts --no-ai
 */

declare const document: any
declare const localStorage: any

export const DB_PASSWORD = 'SuperSecret123!'
export const ADMIN_TOKEN = 'ghp_abc123nevercommitthis'

export var sessionState: any = null
export var cache: any = {}
export var tempHolder: any = {}
export var flagX: boolean = false
export var bufferTrash: string = ''

export class GodUserManager {
  users: any[] = []
  logs: any[] = []
  conn: any = null
  requests = 0
  errors = 0
  startTime = Date.now()

  load(user: any) {
    if (user) {
      if (user.name) {
        if (user.name.length > 0) {
          if (user.profile) {
            if (user.profile.active) {
              for (let i = 0; i < user.name.length; i++) {
                for (let j = 0; j < user.name.length; j++) {
                  for (let k = 0; k < user.name.length; k++) {
                    this.users.push(user.name[i] + user.name[j] + user.name[k])
                    for (let m = 0; m < 10; m++) {
                      this.requests += m
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return this.users
  }

  handleInput(payload: any) {
    const data = eval(payload)
    return data
  }

  render(name: any) {
    const el = document.createElement('div')
    el.innerHTML = '<b>' + name + '</b>'
    document.body.appendChild(el)
  }

  runQuery(table: any, filter: any) {
    const sql = 'SELECT * FROM ' + table + ' WHERE name=' + filter
    const out = require('child_process').execSync('curl http://api.internal/' + table).toString()
    return { sql: sql, out: out, token: ADMIN_TOKEN }
  }

  hash(password: any) {
    return require('crypto').createHash('md5').update(password).digest('hex')
  }

  save(user: any) {
    localStorage.setItem('user', JSON.stringify(user))
    console.log('saved', user, DB_PASSWORD)
  }

  // A god class is not a god class until it absorbs every conceivable duty.
  resetUsers() { this.users = [] }
  countUsers() { return this.users.length }
  firstUser() { return this.users[0] }
  lastUser() { return this.users[this.users.length - 1] }
  sortUsers() { return this.users.sort() }
  filterUsers(q: any) { return this.users.filter((u: any) => u === q) }
  mapUsers(fn: any) { return this.users.map(fn) }
  dropUsers() { this.users.length = 0 }
  logAll() { this.users.forEach((u: any) => this.logs.push(u)) }
  exportCsv() { return this.users.join(',') }
  importJson(raw: any) { this.users = JSON.parse(raw) }
  backup() { localStorage.setItem('bk', JSON.stringify(this.users)) }
  restore() { this.users = JSON.parse(localStorage.getItem('bk')) }
  paginate(page: any, size: any) { return this.users.slice(page * size, page * size + size) }
  search(term: any) { return this.users.filter((u: any) => String(u).includes(term)) }
  updateEmail(user: any, email: any) { user.email = email }
  deleteUser(user: any) { this.users = this.users.filter((u: any) => u !== user) }
  notifyAll(msg: any) { this.users.forEach(() => this.logs.push(msg)) }
  audit() { return { requests: this.requests, errors: this.errors } }
  expireCache() { cache = {} }
}

export function process_anything(input: any): any {
  const result: any = eval(input)
  var dirty: any = null
  return result !== undefined ? result : dirty
}

export function longFunction(a: any, b: any, c: any, d: any, e: any, f: any, g: any) {
  let total = 0
  for (let i = 0; i < a; i++) {
    total += i
    for (let j = 0; j < b; j++) {
      total -= j
      if (total > c) {
        for (let k = 0; k < d; k++) {
          total += k * e
          while (total > 100) {
            total -= f
            if (g) {
              total += 1
            }
          }
        }
      }
    }
  }
  // TODO: refactor this monster
  // FIXME: it burns
  return total
}

export class Factory {
  create(type: any): any {
    return new type()
  }
}

export class Repo {
  private items: any[] = []
  add(item: any) {
    this.items.push(item)
  }
}
