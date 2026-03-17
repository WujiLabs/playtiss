// Copyright (c) 2026 Wuji Labs Inc
// Portions Copyright (c) 2023-2026 Pinscreen, Inc.
// Original source / algorithm or asset licensed from:
// Pinscreen, Inc.
// https://www.pinscreen.com/
//
// https://betterprogramming.pub/implement-your-own-bluebird-style-promise-map-in-js-7c081b7ad02c

export default async function map<T, R>(
  iterable: Iterable<T>,
  mapper: (value: T, index: number) => R | Promise<R>,
  options?: { concurrency: number },
) {
  options = options || { concurrency: 0 }
  let concurrency = options.concurrency || Infinity

  let index = 0
  const results: R[] = []
  const iterator = iterable[Symbol.iterator]()
  const promises: Promise<void>[] = []

  while (concurrency-- > 0) {
    const promise = wrappedMapper()
    if (promise) promises.push(promise)
    else break
  }

  return Promise.all(promises).then(() => results)

  function wrappedMapper(): Promise<void> | void {
    const next = iterator.next()
    if (next.done) return
    const i = index++
    const mapped = mapper(next.value, i)
    return Promise.resolve(mapped).then((resolved) => {
      results[i] = resolved
      return wrappedMapper()
    })
  }
}
