import {
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { PageBuilder } from './page.js';

export class ScreenError extends Error {
  constructor(message: string, readonly code?: unknown) {
    super(message);
    this.name = 'ScreenError';
  }
}

/**
 * A mounted glasses page. Holds the builder that produced it so updates can
 * address containers by name instead of by the numeric id the SDK wants.
 *
 * `createStartUpPageContainer` must succeed before any other glasses UI call —
 * including the glasses microphone — so `Screen.mount` is normally the first
 * thing an app does after `EvenApp.start`.
 */
export class Screen {
  private constructor(
    private bridge: EvenAppBridge,
    private builder: PageBuilder,
  ) {}

  static async mount(bridge: EvenAppBridge, builder: PageBuilder): Promise<Screen> {
    const result = await bridge.createStartUpPageContainer(builder.toStartUpPage());
    if (result !== StartUpPageCreateResult.success) {
      throw new ScreenError(`createStartUpPageContainer failed: ${String(result)}`, result);
    }
    return new Screen(bridge, builder);
  }

  /** Replace the whole page. Rebuilding without menu items clears the custom menu. */
  async rebuild(builder: PageBuilder): Promise<void> {
    const ok = await this.bridge.rebuildPageContainer(builder.toRebuildPage());
    if (!ok) throw new ScreenError('rebuildPageContainer returned false.');
    this.builder = builder;
  }

  /** Update one text container in place — far cheaper than a full rebuild. */
  async setText(
    name: string,
    content: string,
    options: { brightness?: number } = {},
  ): Promise<void> {
    const ok = await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: this.builder.idOf(name),
        containerName: name,
        content,
        ...(options.brightness === undefined ? {} : { textColor: options.brightness }),
      }),
    );
    if (!ok) throw new ScreenError(`textContainerUpgrade failed for "${name}".`);
  }

  /** Push grayscale bytes into an image container created by the builder. */
  async setImage(name: string, imageData: number[] | Uint8Array): Promise<void> {
    const result = await this.bridge.updateImageRawData(
      new ImageRawDataUpdate({
        containerID: this.builder.idOf(name),
        containerName: name,
        imageData,
      }),
    );
    if (result !== ImageRawDataUpdateResult.success) {
      throw new ScreenError(`updateImageRawData failed for "${name}": ${String(result)}`, result);
    }
  }

  /** `exitMode` 0 closes the page; 1 asks the foreground layer to decide. */
  async close(exitMode = 0): Promise<void> {
    await this.bridge.shutDownPageContainer(exitMode);
  }
}
