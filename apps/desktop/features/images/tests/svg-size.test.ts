import { describe, expect, it } from "vite-plus/test";
import { svgIntrinsicSize } from "../web/lib/svg-size";

describe("svgIntrinsicSize", () => {
  it("reads width and height", () => {
    expect(
      svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="103" height="150"/>'),
    ).toEqual({
      width: 103,
      height: 150,
    });
  });

  it("sizes from the viewBox when width and height are missing", () => {
    expect(svgIntrinsicSize('<?xml version="1.0"?><svg viewBox="0 0 640 480"><g/></svg>')).toEqual({
      width: 640,
      height: 480,
    });
    expect(svgIntrinsicSize("<svg viewBox='0,0,20.5,10'/>")).toEqual({ width: 20.5, height: 10 });
  });

  it("uses the viewBox for relative units", () => {
    expect(svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 300 200"/>')).toEqual({
      width: 300,
      height: 200,
    });
    expect(svgIntrinsicSize('<svg width="2em" height="1ex" viewBox="0 0 30 10"/>')).toEqual({
      width: 30,
      height: 10,
    });
  });

  it("uses the viewBox for a tiny declared size", () => {
    expect(svgIntrinsicSize('<svg width="1" height="1" viewBox="0 0 400 300"/>')).toEqual({
      width: 400,
      height: 300,
    });
    // a tiny size with no viewBox is all there is
    expect(svgIntrinsicSize('<svg width="1" height="1"/>')).toEqual({ width: 1, height: 1 });
  });

  it("converts absolute units and derives the missing side from the viewBox ratio", () => {
    expect(svgIntrinsicSize('<svg width="1in" height="2in"/>')).toEqual({ width: 96, height: 192 });
    expect(svgIntrinsicSize('<svg width="200" viewBox="0 0 100 50"/>')).toEqual({
      width: 200,
      height: 100,
    });
  });

  it("is not fooled by stroke-width or other attributes", () => {
    const size = svgIntrinsicSize('<svg stroke-width="9" data-height="9" viewBox="0 0 50 60"/>');
    expect(size).toEqual({ width: 50, height: 60 });
  });

  it("answers null when the file says nothing usable", () => {
    expect(svgIntrinsicSize("<svg/>")).toBeNull();
    expect(svgIntrinsicSize("not an svg")).toBeNull();
    expect(svgIntrinsicSize('<svg viewBox="0 0 0 0"/>')).toBeNull();
    expect(svgIntrinsicSize('<svg width="100%" height="50%"/>')).toBeNull();
  });
});
