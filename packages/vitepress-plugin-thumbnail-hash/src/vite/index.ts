import { join, relative } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { type Plugin, normalizePath } from 'vite'
import type { SiteConfig } from 'vitepress'

import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { cyan, gray } from 'colorette'
import ora from 'ora'
import { glob } from 'glob'

import type { ThumbHash, ThumbHashCalculated } from '../types'
import { binaryToBase64, hash, normalizeBase64 } from './utils'

interface VitePressConfig {
  vitepress: SiteConfig
}

/**
 * Calculate the thumbhash data for the image.
 *
 * Referenced the following implementations:
 * thumbhash/examples/browser/index.html at main · evanw/thumbhash
 * https://github.com/evanw/thumbhash/blob/main/examples/browser/index.html
 *
 * And the following implementations:
 * vite-plugin-thumbhash/packages/core/index.ts at main · cijiugechu/vite-plugin-thumbhash
 * https://github.com/cijiugechu/vite-plugin-thumbhash/blob/main/packages/core/index.ts
 *
 * @param {Uint8Array} imageData - The image data to be calculated
 * @returns {Promise<Omit<ThumbHash, 'fileName' | 'assetUrl' | 'assetUrlWithBase'>>} - The thumbhash data of the image
 */
async function calculateThumbHashForFile(imageData: Uint8Array): Promise<ThumbHashCalculated> {
  const image = await loadImage(imageData)
  const width = image.width
  const height = image.height

  const scale = 100 / Math.max(width, height)
  const resizedWidth = Math.round(width * scale)
  const resizedHeight = Math.round(height * scale)

  // Paint the image to the canvas.
  const canvas = createCanvas(resizedWidth, resizedHeight)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  // Retrieve back the image data for thumbhash calculation as the
  // form of RGBA matrix.
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)

  // Easy calculation of thumbhash data.
  const thumbHashBinary = rgbaToThumbHash(pixels.width, pixels.height, pixels.data)
  // Encode the thumbhash data to base64 and data URL.
  const thumbHashBase64 = binaryToBase64(thumbHashBinary)
  const thumbHashDataURL = await thumbHashToDataURL(thumbHashBinary)

  return {
    dataBase64: thumbHashBase64,
    dataUrl: thumbHashDataURL,
    width: resizedWidth,
    height: resizedHeight,
    originalWidth: width,
    originalHeight: height,
  }
}

function createThumbHashDataFromThumbHash(
  rootDir: string,
  assetDir: string,
  baseUrl: string,
  imageFileName: string,
  imageFullFileName: string,
  imageFullHash: string,
  imageFileHash: string,
  thumbHash: ThumbHashCalculated,
): ThumbHash {
  const fileName = relative(rootDir, imageFileName)

  const thumbhashData: ThumbHash = {
    ...thumbHash,
    assetFileName: normalizePath(relative(rootDir, imageFullFileName)),
    assetFullFileName: normalizePath(imageFullFileName),
    assetFullHash: imageFullHash,
    assetFileHash: imageFileHash,
    assetUrl: normalizePath(join(assetDir, fileName)),
    assetUrlWithBase: normalizePath(join(baseUrl, assetDir, fileName)),
  }

  // Since assets url is used to refer to the image when rendered
  // in the HTML, we need to ensure that the asset URL starts with a slash
  // where base is not included.
  if (!thumbhashData.assetUrlWithBase.startsWith('/'))
    thumbhashData.assetUrlWithBase = `/${thumbhashData.assetUrlWithBase}`

  return thumbhashData
}

/**
 * The Vite plugin to pre-process images and generate thumbhash data for them.
 *
 * @returns {Plugin} - The Vite plugin instance
 */
export function ThumbnailHashImages(): Plugin {
  return {
    name: '@nolebase/vitepress-plugin-thumbnail-hash/images',
    enforce: 'pre',
    config() {
      return {
        optimizeDeps: {
          exclude: [
            '@nolebase/vitepress-plugin-thumbnail-hash/client',
          ],
        },
        ssr: {
          noExternal: [
            '@nolebase/vitepress-plugin-thumbnail-hash',
          ],
        },
      }
    },
    async configResolved(config) {
      const root = config.root
      const vitepressConfig = (config as unknown as VitePressConfig).vitepress

      const startsAt = Date.now()

      const moduleNamePrefix = cyan('@nolebase/vitepress-plugin-thumbnail-hash/images')
      const grayPrefix = gray(':')
      const spinnerPrefix = `${moduleNamePrefix}${grayPrefix}`

      const spinner = ora({ discardStdin: false, isEnabled: config.command === 'serve' })

      spinner.start(`${spinnerPrefix} Prepare to generate hashes for images...`)

      const cacheDir = join(vitepressConfig.cacheDir, '@nolebase', 'vitepress-plugin-thumbnail-hash', 'thumbhashes')
      await mkdir(cacheDir, { recursive: true })
      await rm(join(cacheDir, '*'), { force: true, recursive: true })

      spinner.text = `${spinnerPrefix} Searching for images...`

      const files = await glob(`${root}/**/*.+(jpg|jpeg|png)`, { nodir: true })

      spinner.text = `${spinnerPrefix} Calculating thumbhashes for images...`

      const thumbhashes = await Promise.all(files.map(async (file) => {
        const readImageRawData = await readFile(file)

        // The hash implementation is mirrored and simulated from the rollup.
        // But it's never guaranteed to be the same as the rollup's hash.
        const imageFullHash = await hash(readImageRawData, -1)
        const imageFileHash = normalizeBase64(imageFullHash.substring(0, 10))

        // Calculate the thumbhash data for the image as thumbhash demonstrates.
        const calculatedThumbhashData = await calculateThumbHashForFile(readImageRawData)

        // Construct the thumbhash data for the image.
        return createThumbHashDataFromThumbHash(
          root,
          vitepressConfig.assetsDir,
          vitepressConfig.site.base,
          file,
          file,
          imageFullHash,
          imageFileHash,
          calculatedThumbhashData,
        )
      }))

      spinner.text = `${spinnerPrefix} Aggregating calculated thumbhash data...`

      const thumbhashMap: Record<string, ThumbHash> = {}

      for (const thumbhash of thumbhashes)
        thumbhashMap[thumbhash.assetFileName] = thumbhash

      spinner.text = `${spinnerPrefix} Writing thumbhash data to cache...`

      await writeFile(join(cacheDir, 'map.json'), JSON.stringify(thumbhashMap, null, 2))

      const elapsed = Date.now() - startsAt
      spinner.succeed(`${spinnerPrefix} Done. ${gray(`(${elapsed}ms)`)}`)
    },
  }
}
