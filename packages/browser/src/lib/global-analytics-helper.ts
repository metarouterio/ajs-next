import { AnalyticsSnippet } from '../browser/standalone-interface'

/**
 * Stores the global window analytics key
 */
let _globalAnalyticsKey = 'analytics'

/**
 * Gets the global analytics/buffer
 * @param key name of the window property where the buffer is stored (default: analytics)
 * @returns AnalyticsSnippet
 */
export function getGlobalAnalytics(): AnalyticsSnippet | undefined {
  const keys = _globalAnalyticsKey.split('.')
  let currentObj: any = window
  if (keys.length > 1) {
    keys.forEach((key: string) => {
      currentObj = currentObj[key]
    })
    return currentObj
  } else {
    return (window as any)[_globalAnalyticsKey]
  }
}

/**
 * Replaces the global window key for the analytics/buffer object
 * @param key key name
 */
export function setGlobalAnalyticsKey(key: string) {
  _globalAnalyticsKey = key
}

/**
 * Sets the global analytics object
 * @param analytics analytics snippet
 */
export function setGlobalAnalytics(analytics: AnalyticsSnippet): void {
  const keys = _globalAnalyticsKey.split('.')
  let currentObj: any = window
  const lastIndex = keys.length - 1

  if (keys.length > 1) {
    keys.forEach((key: string, index: number) => {
      if (index === lastIndex) {
        currentObj[key] = analytics
      } else {
        if (!currentObj[key]) {
          currentObj[key] = {}
        }
        currentObj = currentObj[key]
      }
    })
  } else {
    ;(window as any)[_globalAnalyticsKey] = analytics
  }
}
