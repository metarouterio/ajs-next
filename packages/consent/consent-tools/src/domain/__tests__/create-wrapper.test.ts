import * as ConsentStamping from '../consent-stamping'
import * as DisableSegment from '../disable-segment'
import { createWrapper } from '../create-wrapper'
import { AbortLoadError, LoadContext } from '../load-cancellation'
import type {
  CreateWrapperSettings,
  AnyAnalytics,
  CDNSettings,
  AnalyticsBrowserSettings,
  Categories,
} from '../../types'
import { CDNSettingsBuilder } from '@internal/test-helpers'
import { assertIntegrationsContainOnly } from './assertions/integrations-assertions'
import { AnalyticsService } from '../analytics'

jest.mock('../disable-segment')
const disableSegmentMock = jest.mocked(DisableSegment)

const DEFAULT_LOAD_SETTINGS = {
  writeKey: 'foo',
  cdnSettings: { integrations: {} },
}

const mockGetCategories: jest.MockedFn<CreateWrapperSettings['getCategories']> =
  jest.fn().mockImplementation(() => ({ Advertising: true }))

const analyticsLoadSpy: jest.MockedFn<AnyAnalytics['load']> = jest.fn()
const analyticsPageSpy: jest.MockedFn<AnyAnalytics['page']> = jest.fn()
const addSourceMiddlewareSpy = jest.fn()
let analyticsOnSpy: jest.MockedFn<AnyAnalytics['on']>
const analyticsTrackSpy: jest.MockedFn<AnyAnalytics['track']> = jest.fn()
let consoleErrorSpy: jest.SpiedFunction<typeof console['error']>

const getAnalyticsLoadLastCall = () => {
  const [arg1, arg2] = analyticsLoadSpy.mock.lastCall!
  const cdnSettings = (arg1 as any).cdnSettings as CDNSettings
  const updateCDNSettings = arg2!.updateCDNSettings || ((id) => id)
  const updatedCDNSettings = updateCDNSettings(cdnSettings) as CDNSettings
  return {
    args: [arg1 as AnalyticsBrowserSettings, arg2!] as const,
    cdnSettings,
    updatedCDNSettings,
  }
}

let analytics: AnyAnalytics, cdnSettingsBuilder: CDNSettingsBuilder
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error')
  cdnSettingsBuilder = new CDNSettingsBuilder()
  analyticsOnSpy = jest.fn().mockImplementation((event, fn) => {
    if (event === 'initialize') {
      fn(cdnSettingsBuilder.build())
    } else {
      console.error('event not recognized')
    }
  })

  class MockAnalytics implements AnyAnalytics {
    page = analyticsPageSpy
    track = analyticsTrackSpy
    on = analyticsOnSpy
    load = analyticsLoadSpy
    addSourceMiddleware = addSourceMiddlewareSpy
  }
  analytics = new MockAnalytics()
})

const wrapTestAnalytics = (overrides: Partial<CreateWrapperSettings> = {}) =>
  createWrapper({
    getCategories: mockGetCategories,
    ...overrides,
  })(analytics)

describe(createWrapper, () => {
  it('should allow load arguments to be forwarded correctly from the patched analytics.load to the underlying load method', async () => {
    const mockCdnSettings = cdnSettingsBuilder.build()

    wrapTestAnalytics()

    const loadSettings1 = {
      ...DEFAULT_LOAD_SETTINGS,
      cdnSettings: mockCdnSettings,
    }
    const loadSettings2 = {
      anyOption: 'foo',
      updateCDNSettings: (cdnSettings: any) => ({
        ...cdnSettings,
        some_new_key: 123,
      }),
    }
    await analytics.load(loadSettings1, loadSettings2)
    const { args: loadCallArgs, updatedCDNSettings } =
      getAnalyticsLoadLastCall()
    expect(loadCallArgs.length).toBe(2)

    expect(Object.keys(loadCallArgs[0])).toEqual(
      expect.arrayContaining(['cdnSettings', 'writeKey'])
    )

    expect(Object.keys(loadCallArgs[1])).toEqual(
      expect.arrayContaining(['anyOption', 'updateCDNSettings'])
    )
    expect(loadSettings2).toEqual(expect.objectContaining({ anyOption: 'foo' }))
    expect(updatedCDNSettings).toEqual(
      expect.objectContaining({ some_new_key: 123 })
    )
  })

  it('should invoke addSourceMiddleware in order to stamp the event', async () => {
    wrapTestAnalytics()
    await analytics.load(DEFAULT_LOAD_SETTINGS)
    expect(addSourceMiddlewareSpy).toBeCalledWith(expect.any(Function))
  })

  it('should be chainable', async () => {
    await wrapTestAnalytics().load(DEFAULT_LOAD_SETTINGS)
    const { args } = getAnalyticsLoadLastCall()
    expect(args.length).toBeTruthy()
  })

  describe('shouldLoadSegment', () => {
    describe('Throwing errors / aborting load', () => {
      const createShouldLoadThatThrows = (
        ...args: Parameters<LoadContext['abort']>
      ) => {
        let err: Error
        const shouldLoadSegment = jest
          .fn()
          .mockImplementation((ctx: LoadContext) => {
            try {
              ctx.abort(...args)
            } catch (_err: any) {
              err = _err
            }
          })
        return { shouldLoadSegment, getError: () => err }
      }

      it('should throw a special error if ctx.abort is called', async () => {
        const { shouldLoadSegment, getError } = createShouldLoadThatThrows({
          loadSegmentNormally: true,
        })
        wrapTestAnalytics({
          shouldLoadSegment,
        })
        await analytics.load(DEFAULT_LOAD_SETTINGS)
        expect(getError() instanceof AbortLoadError).toBeTruthy()
      })

      it.each([{ loadSegmentNormally: true }, { loadSegmentNormally: false }])(
        `should not log a console error or throw an error if ctx.abort is called (%p)`,
        async (args) => {
          wrapTestAnalytics({
            shouldLoadSegment: (ctx) => ctx.abort(args),
          })
          const result = await analytics.load(DEFAULT_LOAD_SETTINGS)
          expect(result).toBeUndefined()
          expect(consoleErrorSpy).not.toBeCalled()
        }
      )

      it('should pass analytics.load args straight through to the analytics instance if ctx.abort() is called', async () => {
        wrapTestAnalytics({
          shouldLoadSegment: (ctx) => {
            ctx.abort({
              loadSegmentNormally: true,
            })
          },
        })

        const mockCdnSettings = cdnSettingsBuilder.build()
        await analytics.load(
          {
            ...DEFAULT_LOAD_SETTINGS,
            cdnSettings: mockCdnSettings,
          },
          { foo: 'bar' } as any
        )
        expect(analyticsLoadSpy).toBeCalled()
        const { args } = getAnalyticsLoadLastCall()
        expect(args[0]).toEqual({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })
        expect(args[1]).toEqual({ foo: 'bar' } as any)
      })

      it('should allow segment loading to be completely aborted via ctx.abort', async () => {
        wrapTestAnalytics({
          shouldLoadSegment: (ctx) => {
            ctx.abort({
              loadSegmentNormally: false, // magic config option
            })
            throw new Error('Fail')
          },
        })
        await analytics.load(DEFAULT_LOAD_SETTINGS)
        expect(analyticsLoadSpy).not.toBeCalled()
      })
      it('should throw a validation error if ctx.abort is called incorrectly', async () => {
        const { getError, shouldLoadSegment } = createShouldLoadThatThrows(
          undefined as any
        )
        wrapTestAnalytics({
          shouldLoadSegment,
        })
        await analytics.load(DEFAULT_LOAD_SETTINGS)
        expect(getError().message).toMatch(/validation/i)
      })

      it('An unrecognized Error (non-consent) error should bubble up, but we should not log any additional console error', async () => {
        const err = new Error('hello')
        wrapTestAnalytics({
          shouldLoadSegment: () => {
            throw err
          },
        })

        await expect(() =>
          analytics.load(DEFAULT_LOAD_SETTINGS)
        ).rejects.toThrow(err)

        expect(consoleErrorSpy).not.toBeCalled()
        expect(analyticsLoadSpy).not.toBeCalled()
      })
    })
    it('should first call shouldLoadSegment(), then wait for it to resolve/return before calling analytics.load()', async () => {
      const fnCalls: string[] = []
      analyticsLoadSpy.mockImplementationOnce(() => {
        fnCalls.push('analytics.load')
      })

      const shouldLoadMock: jest.Mock<undefined> = jest
        .fn()
        .mockImplementationOnce(async () => {
          fnCalls.push('shouldLoadSegment')
        })

      wrapTestAnalytics({
        shouldLoadSegment: shouldLoadMock,
      })

      await analytics.load(DEFAULT_LOAD_SETTINGS)
      expect(fnCalls).toEqual(['shouldLoadSegment', 'analytics.load'])
    })
  })

  describe('getCategories', () => {
    test.each([
      {
        shouldLoadSegment: () => undefined,
        returnVal: 'undefined',
      },
      {
        shouldLoadSegment: () => Promise.resolve(undefined),
        returnVal: 'Promise<undefined>',
      },
    ])(
      'if shouldLoadSegment() returns nil ($returnVal), intial categories will come from getCategories()',
      async ({ shouldLoadSegment }) => {
        const mockCdnSettings = cdnSettingsBuilder
          .addActionDestinationSettings({
            creationName: 'mockIntegration',
            consentSettings: { categories: ['Advertising'] },
          })
          .build()

        wrapTestAnalytics({
          shouldLoadSegment: shouldLoadSegment,
        })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })

        const { updatedCDNSettings } = getAnalyticsLoadLastCall()
        expect(analyticsLoadSpy).toBeCalled()
        expect(updatedCDNSettings).toBeTruthy()
        expect(mockGetCategories).toBeCalled()
      }
    )

    test.each([
      {
        getCategories: () => ({ Advertising: true }),
        returnVal: 'Categories',
      },
      {
        getCategories: () => Promise.resolve({ Advertising: true }),
        returnVal: 'Promise<Categories>',
      },
    ])(
      'if shouldLoadSegment() returns categories ($returnVal), those will be the initial categories',
      async ({ getCategories }) => {
        const mockCdnSettings = cdnSettingsBuilder
          .addActionDestinationSettings({
            creationName: 'mockIntegration',
            consentSettings: { categories: ['Advertising'] },
          })
          .build()

        mockGetCategories.mockImplementationOnce(getCategories)

        wrapTestAnalytics({
          getCategories: mockGetCategories,
          shouldLoadSegment: () => undefined,
        })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })
        const { updatedCDNSettings } = getAnalyticsLoadLastCall()
        expect(analyticsLoadSpy).toBeCalled()
        expect(mockGetCategories).toBeCalled()
        expect(updatedCDNSettings).toBeTruthy()
      }
    )
  })

  describe('Settings Validation', () => {
    /* NOTE: This test suite is meant to be minimal -- please see validation/__tests__ */

    test('createWrapper should throw if user-defined settings/configuration/options are invalid', () => {
      expect(() =>
        wrapTestAnalytics({ getCategories: {} as any })
      ).toThrowError(/validation/i)
    })

    test('analytics.load should reject if categories are in the wrong format', async () => {
      wrapTestAnalytics({
        shouldLoadSegment: () => Promise.resolve('sup' as any),
      })
      await expect(() => analytics.load(DEFAULT_LOAD_SETTINGS)).rejects.toThrow(
        /validation/i
      )
    })

    test('analytics.load should reject if categories are undefined', async () => {
      wrapTestAnalytics({
        getCategories: () => undefined as any,
        shouldLoadSegment: () => undefined,
      })
      await expect(() => analytics.load(DEFAULT_LOAD_SETTINGS)).rejects.toThrow(
        /validation/i
      )
    })
  })

  describe('Disabling/Enabling integrations before analytics initialization (device mode gating)', () => {
    it('should filter remote plugins based on consent settings', async () => {
      wrapTestAnalytics()
      const creationNameNoConsentData =
        'should.be.enabled.bc.no.consent.settings'
      const creationNameWithConsentMatch = 'should.be.enabled.bc.consent.match'
      const creationNameWithConsentMismatch = 'should.be.disabled'

      const mockCdnSettings = cdnSettingsBuilder
        .addActionDestinationSettings(
          {
            creationName: creationNameWithConsentMismatch,
            consentSettings: {
              categories: ['Foo'],
            },
          },
          {
            creationName: creationNameNoConsentData,
          },
          {
            creationName: creationNameWithConsentMatch,
            consentSettings: {
              categories: ['Advertising'],
            },
          }
        )
        .build()

      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
        cdnSettings: mockCdnSettings,
      })

      expect(analyticsLoadSpy).toBeCalled()
      const { updatedCDNSettings } = getAnalyticsLoadLastCall()

      expect(typeof updatedCDNSettings.remotePlugins).toBe('object')

      // remote plugins should be filtered based on consent settings
      assertIntegrationsContainOnly(
        [creationNameNoConsentData, creationNameWithConsentMatch],
        mockCdnSettings,
        updatedCDNSettings
      )
    })

    it('should allow integration if it has one category and user has consented to that category', async () => {
      const mockCdnSettings = cdnSettingsBuilder
        .addActionDestinationSettings({
          creationName: 'mockIntegration',
          consentSettings: {
            categories: ['Foo'],
          },
        })
        .build()

      wrapTestAnalytics({
        shouldLoadSegment: () => ({ Foo: true }),
      })
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
        cdnSettings: mockCdnSettings,
      })
      expect(analyticsLoadSpy).toBeCalled()
      const { updatedCDNSettings } = getAnalyticsLoadLastCall()
      // remote plugins should be filtered based on consent settings
      assertIntegrationsContainOnly(
        ['mockIntegration'],
        mockCdnSettings,
        updatedCDNSettings
      )
    })

    it('should allow integration if it has multiple categories and user consents to all of them.', async () => {
      const mockCdnSettings = cdnSettingsBuilder
        .addActionDestinationSettings({
          creationName: 'mockIntegration',
          consentSettings: {
            categories: ['Foo', 'Bar'],
          },
        })
        .build()

      wrapTestAnalytics({
        shouldLoadSegment: () => ({ Foo: true, Bar: true }),
      })
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
        cdnSettings: mockCdnSettings,
      })
      expect(analyticsLoadSpy).toBeCalled()
      const { updatedCDNSettings } = getAnalyticsLoadLastCall()
      // remote plugins should be filtered based on consent settings
      assertIntegrationsContainOnly(
        ['mockIntegration'],
        mockCdnSettings,
        updatedCDNSettings
      )
    })

    it('should disable integration if it has multiple categories but user has only consented to one', async () => {
      const mockCdnSettings = cdnSettingsBuilder
        .addActionDestinationSettings({
          creationName: 'mockIntegration',
          consentSettings: {
            categories: ['Foo', 'Bar'],
          },
        })
        .build()

      wrapTestAnalytics({
        shouldLoadSegment: () => ({ Foo: true }),
      })
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
        cdnSettings: mockCdnSettings,
      })

      const { updatedCDNSettings } = getAnalyticsLoadLastCall()
      assertIntegrationsContainOnly(
        ['mockIntegation'],
        mockCdnSettings,
        updatedCDNSettings
      )
    })
  })

  describe('shouldDisableSegment', () => {
    it('should load analytics if disableAll returns false', async () => {
      wrapTestAnalytics({
        shouldDisableSegment: () => false,
      })
      await analytics.load(DEFAULT_LOAD_SETTINGS)
      expect(analyticsLoadSpy).toBeCalled()
    })

    it('should not load analytics if disableAll returns true', async () => {
      wrapTestAnalytics({
        shouldDisableSegment: () => true,
      })
      await analytics.load(DEFAULT_LOAD_SETTINGS)
      expect(mockGetCategories).not.toBeCalled()
      expect(addSourceMiddlewareSpy).not.toBeCalled()
      expect(analyticsLoadSpy).not.toBeCalled()
    })
  })

  describe('shouldEnableIntegration', () => {
    it('should let user customize the logic that determines whether or not a destination is enabled', async () => {
      const disabledDestinationCreationName = 'DISABLED'
      const mockCdnSettings = cdnSettingsBuilder
        .addActionDestinationSettings(
          {
            creationName: disabledDestinationCreationName,
          },
          { creationName: 'ENABLED' }
        )
        .build()

      wrapTestAnalytics({
        shouldEnableIntegration: (categories, consentedCategories, plugin) => {
          if (plugin.creationName === disabledDestinationCreationName)
            return false
          if (!categories.length) return true
          return categories.some((c) => consentedCategories[c])
        },
      })
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
        cdnSettings: mockCdnSettings,
      })
      const { updatedCDNSettings } = getAnalyticsLoadLastCall()
      assertIntegrationsContainOnly(
        ['ENABLED'],
        mockCdnSettings,
        updatedCDNSettings
      )
    })
  })

  describe('Consent Stamping', () => {
    test.each([
      {
        getCategories: () => ({
          Something: true,
          SomethingElse: false,
        }),
        returnVal: 'Categories',
      },
      {
        getCategories: () =>
          Promise.resolve({
            Something: true,
            SomethingElse: false,
          }),
        returnVal: 'Promise<Categories>',
      },
    ])(
      'should, by default, stamp the event with _all_ consent info if getCategories returns $returnVal',
      async ({ getCategories }) => {
        const fn = jest.spyOn(
          ConsentStamping,
          'createConsentStampingMiddleware'
        )
        const mockCdnSettings = cdnSettingsBuilder.build()

        wrapTestAnalytics({
          getCategories,
        })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })

        const getCategoriesFn = fn.mock.lastCall![0]
        await expect(getCategoriesFn()).resolves.toEqual({
          Something: true,
          SomethingElse: false,
        })
      }
    )

    describe('pruneUnmappedCategories', () => {
      it('should throw an error if there are no configured categories', async () => {
        const fn = jest.spyOn(
          ConsentStamping,
          'createConsentStampingMiddleware'
        )
        const mockCdnSettings = cdnSettingsBuilder
          .addActionDestinationSettings({
            creationName: 'Some Other Plugin',
          })
          .build()

        wrapTestAnalytics({ pruneUnmappedCategories: true })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })

        const getCategoriesFn = fn.mock.lastCall![0]
        await expect(() =>
          getCategoriesFn()
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"[Validation] Invariant: No consent categories defined in Segment (Received: [])"`
        )
      })

      it('should exclude properties that are not configured based on the allCategories array', async () => {
        const fn = jest.spyOn(
          ConsentStamping,
          'createConsentStampingMiddleware'
        )
        const mockCdnSettings = cdnSettingsBuilder
          .addActionDestinationSettings({
            creationName: 'Some Other Plugin',
            consentSettings: {
              categories: ['Foo'],
            },
          })
          .build()

        ;(mockCdnSettings as any).consentSettings = {
          allCategories: ['Foo', 'Bar'],
        }

        wrapTestAnalytics({
          pruneUnmappedCategories: true,
          getCategories: () => ({
            Foo: true,
            Bar: false,
            Rand1: false,
            Rand2: true,
          }),
        })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })

        const getCategoriesFn = fn.mock.lastCall![0]
        await expect(getCategoriesFn()).resolves.toEqual({
          Foo: true,
          Bar: false,
        })
      })

      it('should exclude properties that are not configured if integrationCategoryMappings are passed', async () => {
        const fn = jest.spyOn(
          ConsentStamping,
          'createConsentStampingMiddleware'
        )
        const mockCdnSettings = cdnSettingsBuilder
          .addActionDestinationSettings({
            creationName: 'Some Other Plugin',
          })
          .build()

        wrapTestAnalytics({
          pruneUnmappedCategories: true,
          getCategories: () => ({
            Foo: true,
            Rand1: true,
            Rand2: false,
          }),
          integrationCategoryMappings: {
            'Some Other Plugin': ['Foo'],
          },
        })
        await analytics.load({
          ...DEFAULT_LOAD_SETTINGS,
          cdnSettings: mockCdnSettings,
        })

        const getCategoriesFn = fn.mock.lastCall![0]
        await expect(getCategoriesFn()).resolves.toEqual({ Foo: true })
      })
    })
  })

  describe('registerOnConsentChanged', () => {
    const sendConsentChangedEventSpy = jest.spyOn(
      AnalyticsService.prototype,
      'consentChange'
    )

    let categoriesChangedCb: (categories: Categories) => void = () => {
      throw new Error('Not implemented')
    }

    const registerOnConsentChanged = jest.fn(
      (consentChangedCb: (c: Categories) => void) => {
        // simulate a OneTrust.onConsentChanged event callback
        categoriesChangedCb = jest.fn((categories: Categories) =>
          consentChangedCb(categories)
        )
      }
    )
    it('should expect a callback', async () => {
      wrapTestAnalytics({
        registerOnConsentChanged: registerOnConsentChanged,
      })
      await analytics.load(DEFAULT_LOAD_SETTINGS)

      expect(sendConsentChangedEventSpy).not.toBeCalled()
      expect(registerOnConsentChanged).toBeCalledTimes(1)
      categoriesChangedCb({ C0001: true, C0002: false })
      expect(registerOnConsentChanged).toBeCalledTimes(1)
      expect(sendConsentChangedEventSpy).toBeCalledTimes(1)

      // if OnConsentChanged callback is called with categories, it should send event
      expect(analyticsTrackSpy).toBeCalledWith(
        'Segment Consent Preference',
        undefined,
        { consent: { categoryPreferences: { C0001: true, C0002: false } } }
      )
    })
    it('should throw an error if categories are invalid', async () => {
      consoleErrorSpy.mockImplementationOnce(() => undefined)

      wrapTestAnalytics({
        registerOnConsentChanged: registerOnConsentChanged,
      })

      await analytics.load(DEFAULT_LOAD_SETTINGS)
      expect(consoleErrorSpy).not.toBeCalled()
      categoriesChangedCb(['OOPS'] as any)
      expect(consoleErrorSpy).toBeCalledTimes(1)
      const err = consoleErrorSpy.mock.lastCall![0]
      expect(err.toString()).toMatch(/validation/i)
      expect(analyticsTrackSpy).not.toBeCalled()
    })
  })

  describe('Disabling Segment Automatically', () => {
    // if user has no unmapped destinations and only irrelevant categories, we disable segment.
    // for more tests, see disable-segment.test.ts
    it('should always disable if segmentShouldBeDisabled returns true', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(true)
      wrapTestAnalytics()
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
      })
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable!(
          DEFAULT_LOAD_SETTINGS.cdnSettings
        )
      ).toBe(true)
    })
    it('should disable if segmentShouldBeDisabled returns false and disable is not overridden', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(false)
      wrapTestAnalytics()
      await analytics.load({
        ...DEFAULT_LOAD_SETTINGS,
      })
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable!(
          DEFAULT_LOAD_SETTINGS.cdnSettings
        )
      ).toBe(false)
    })

    it('should be disabled if if a user overrides disabled with boolean: true, and pass through a boolean', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(false)
      wrapTestAnalytics()
      await analytics.load(
        {
          ...DEFAULT_LOAD_SETTINGS,
        },
        { disable: true }
      )
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable
      ).toBe(true)
    })

    it('should return true if segment should be disabled, but a user loads a false value', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(true)
      wrapTestAnalytics()
      await analytics.load(
        {
          ...DEFAULT_LOAD_SETTINGS,
        },
        { disable: false }
      )
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable!(
          DEFAULT_LOAD_SETTINGS.cdnSettings
        )
      ).toBe(true)
    })

    it('should handle if a user overrides the value with a function', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(false)
      wrapTestAnalytics()
      await analytics.load(
        {
          ...DEFAULT_LOAD_SETTINGS,
        },
        { disable: () => true }
      )
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable!(
          DEFAULT_LOAD_SETTINGS.cdnSettings
        )
      ).toBe(true)
    })

    it('should enable if user passes the wrong option to "load"', async () => {
      disableSegmentMock.segmentShouldBeDisabled.mockReturnValue(false)
      wrapTestAnalytics()
      await analytics.load(
        {
          ...DEFAULT_LOAD_SETTINGS,
        },
        // @ts-ignore
        { disable: 'foo' }
      )
      expect(
        // @ts-ignore
        analyticsLoadSpy.mock.lastCall[1].disable!(
          DEFAULT_LOAD_SETTINGS.cdnSettings
        )
      ).toBe(false)
    })
  })

  describe('initialPageview', () => {
    it('should send a page event if initialPageview is true', async () => {
      wrapTestAnalytics()
      await analytics.load(DEFAULT_LOAD_SETTINGS, { initialPageview: true })
      expect(analyticsPageSpy).toBeCalledTimes(1)
    })

    it('should not send a page event if set to false', async () => {
      wrapTestAnalytics()
      await analytics.load(DEFAULT_LOAD_SETTINGS, { initialPageview: false })
      expect(analyticsPageSpy).not.toBeCalled()
    })

    it('should not be called if set to undefined', async () => {
      wrapTestAnalytics()
      await analytics.load(DEFAULT_LOAD_SETTINGS, {
        initialPageview: undefined,
      })
      expect(analyticsPageSpy).not.toBeCalled()
    })

    it('setting should always be set to false when forwarding to the underlying analytics instance', async () => {
      wrapTestAnalytics()
      await analytics.load(DEFAULT_LOAD_SETTINGS, { initialPageview: true })
      const lastCall = getAnalyticsLoadLastCall()
      // ensure initialPageview is always set to false so page doesn't get called twice
      expect(lastCall.args[1].initialPageview).toBe(false)
    })

    it('should call page early, even if wrapper is aborted', async () => {
      // shouldLoadSegment can take a while to load, so we want to capture page context early so info is not stale
      wrapTestAnalytics({
        shouldLoadSegment: (ctx) => ctx.abort({ loadSegmentNormally: true }),
      })
      await analytics.load(DEFAULT_LOAD_SETTINGS, { initialPageview: true })
      expect(analyticsPageSpy).toBeCalled()

      const lastCall = getAnalyticsLoadLastCall()
      // ensure initialPageview is always set to false so analytics.page() doesn't get called twice
      expect(lastCall.args[1].initialPageview).toBe(false)
    })

    it('should buffer a page event even if shouldDisableSegment returns true', async () => {
      //  in order to capture page info as early as possible
      wrapTestAnalytics({ shouldDisableSegment: () => true })
      await analytics.load(DEFAULT_LOAD_SETTINGS, { initialPageview: true })
      expect(analyticsPageSpy).toBeCalledTimes(1)
    })
  })
})
