import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  utf8ByteLength,
} from '@evenrealities/even_hub_sdk';
import { LIMITS, PageConstraintError } from './constraints.js';

type Rect = { x: number; y: number; width: number; height: number };

export type TextSpec = Rect & {
  name: string;
  content?: string;
  /** Brightness level 0..4. Omit to use the device default (4). */
  brightness?: number;
  /** Marks this container as the one that receives touch/scroll events. */
  focus?: boolean;
};

export type ListSpec = Rect & {
  name: string;
  items: string[];
  itemWidth?: number;
  selectBorder?: boolean;
  focus?: boolean;
};

export type ImageSpec = Rect & {
  name: string;
  focus?: boolean;
};

export type MenuSpec = { name: string; id: number };

/**
 * Builds a page container payload for `createStartUpPageContainer` /
 * `rebuildPageContainer`.
 *
 * Two things it takes off your hands. First, `containerID` allocation: IDs must
 * be unique across list/text/image on the same page, which is easy to get wrong
 * by hand once a layout has more than a couple of elements. Second, `zOrderIndex`
 * is all-or-nothing per page — if one container sets it every container must,
 * with unique values — so the builder assigns it in declaration order and
 * back-to-front stacking comes for free.
 */
export class PageBuilder {
  private texts: TextContainerProperty[] = [];
  private lists: ListContainerProperty[] = [];
  private images: ImageContainerProperty[] = [];
  private menu: MenuSpec[] = [];
  private nextId = 1;
  private nextZ = 1;
  private names = new Set<string>();

  private claim(name: string): { containerID: number; zOrderIndex: number } {
    if (this.names.has(name)) {
      throw new PageConstraintError(`Duplicate container name "${name}" on the same page.`);
    }
    this.names.add(name);
    return { containerID: this.nextId++, zOrderIndex: this.nextZ++ };
  }

  text(spec: TextSpec): this {
    const { brightness } = spec;
    if (
      brightness !== undefined &&
      (!Number.isInteger(brightness) ||
        brightness < LIMITS.minTextBrightness ||
        brightness > LIMITS.maxTextBrightness)
    ) {
      throw new PageConstraintError(
        `Text "${spec.name}" brightness ${brightness} is outside ` +
          `${LIMITS.minTextBrightness}..${LIMITS.maxTextBrightness}.`,
      );
    }
    const { containerID, zOrderIndex } = this.claim(spec.name);
    this.texts.push(
      new TextContainerProperty({
        containerID,
      zOrderIndex,
        containerName: spec.name,
        xPosition: spec.x,
        yPosition: spec.y,
        width: spec.width,
        height: spec.height,
        content: spec.content ?? '',
        isEventCapture: spec.focus ? 1 : 0,
        ...(brightness === undefined ? {} : { textColor: brightness }),
      }),
    );
    return this;
  }

  list(spec: ListSpec): this {
    const { containerID, zOrderIndex } = this.claim(spec.name);
    this.lists.push(
      new ListContainerProperty({
        containerID,
        zOrderIndex,
        containerName: spec.name,
        xPosition: spec.x,
        yPosition: spec.y,
        width: spec.width,
        height: spec.height,
        isEventCapture: spec.focus ? 1 : 0,
        itemContainer: new ListItemContainerProperty({
          itemCount: spec.items.length,
          itemName: spec.items,
          ...(spec.itemWidth === undefined ? {} : { itemWidth: spec.itemWidth }),
          ...(spec.selectBorder === undefined
            ? {}
            : { isItemSelectBorderEn: spec.selectBorder ? 1 : 0 }),
        }),
      }),
    );
    return this;
  }

  /**
   * Image containers render nothing until `updateImageRawData` sends bytes for
   * them, so creating one is only half the job.
   */
  image(spec: ImageSpec): this {
    const { containerID, zOrderIndex } = this.claim(spec.name);
    this.images.push(
      new ImageContainerProperty({
        containerID,
        zOrderIndex,
        containerName: spec.name,
        xPosition: spec.x,
        yPosition: spec.y,
        width: spec.width,
        height: spec.height,
      }),
    );
    return this;
  }

  /** First-level contextual menu. Omitting it on a rebuild clears the custom menu. */
  menuItem(name: string, id: number): this {
    if (!Number.isInteger(id) || id === 0) {
      throw new PageConstraintError(`Menu item "${name}" needs a non-zero integer id.`);
    }
    if (this.menu.some((m) => m.id === id)) {
      throw new PageConstraintError(`Menu item id ${id} is already used on this page.`);
    }
    if (utf8ByteLength(name) > LIMITS.maxMenuNameBytes) {
      throw new PageConstraintError(
        `Menu item "${name}" is ${utf8ByteLength(name)} UTF-8 bytes; ` +
          `the limit is ${LIMITS.maxMenuNameBytes}.`,
      );
    }
    this.menu.push({ name, id });
    return this;
  }

  /** Container id assigned to a name, for later `textContainerUpgrade` / image updates. */
  idOf(name: string): number {
    const all = [...this.texts, ...this.lists, ...this.images];
    const hit = all.find((c) => c.containerName === name);
    if (!hit?.containerID) {
      throw new PageConstraintError(`No container named "${name}" on this page.`);
    }
    return hit.containerID;
  }

  private validate(): void {
    const total = this.texts.length + this.lists.length + this.images.length;
    if (total < LIMITS.minContainers || total > LIMITS.maxContainers) {
      throw new PageConstraintError(
        `A page needs ${LIMITS.minContainers}..${LIMITS.maxContainers} containers; this one has ${total}.`,
      );
    }
    if (this.texts.length > LIMITS.maxTextContainers) {
      throw new PageConstraintError(
        `${this.texts.length} text containers exceeds the limit of ${LIMITS.maxTextContainers}.`,
      );
    }
    if (this.menu.length > LIMITS.maxMenuItems) {
      throw new PageConstraintError(
        `${this.menu.length} menu items exceeds the limit of ${LIMITS.maxMenuItems}.`,
      );
    }
    const focused = [...this.texts, ...this.lists].filter((c) => c.isEventCapture === 1);
    if (focused.length !== 1) {
      throw new PageConstraintError(
        `Exactly one container must set focus (isEventCapture: 1); found ${focused.length}. ` +
          `Without it the page receives no touch or scroll events.`,
      );
    }
  }

  private payload(): Partial<CreateStartUpPageContainer> {
    this.validate();
    const menuObject = this.menu.length
      ? new MenuContainerProperty({
          menuItems: this.menu.map(
            (m) => new MenuItemProperty({ itemName: m.name, itemID: m.id }),
          ),
        })
      : undefined;

    return {
      containerTotalNum: this.texts.length + this.lists.length + this.images.length,
      ...(this.texts.length ? { textObject: this.texts } : {}),
      ...(this.lists.length ? { listObject: this.lists } : {}),
      ...(this.images.length ? { imageObject: this.images } : {}),
      ...(menuObject ? { menuObject } : {}),
    };
  }

  toStartUpPage(): CreateStartUpPageContainer {
    return new CreateStartUpPageContainer(this.payload());
  }

  toRebuildPage(): RebuildPageContainer {
    return new RebuildPageContainer(this.payload());
  }
}
