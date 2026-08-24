package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
)

type fixtureManifest struct {
	RawSHA256             string               `json:"raw_sha256"`
	RawSizeBytes          int                  `json:"raw_size_bytes"`
	EncodedWidth          int                  `json:"encoded_width"`
	EncodedHeight         int                  `json:"encoded_height"`
	CanonicalSHA256       string               `json:"canonical_sha256"`
	CanonicalAggregateSHA string               `json:"canonical_aggregate_sha256"`
	CanonicalSizeBytes    int                  `json:"canonical_size_bytes"`
	CanonicalWidth        int                  `json:"canonical_width"`
	CanonicalHeight       int                  `json:"canonical_height"`
	CornerSamples         map[string][4]uint32 `json:"corner_samples"`
}

func main() {
	rawPath := flag.String("raw", "", "raw EXIF-6 JPEG output")
	canonicalPath := flag.String("canonical", "", "orientation-normalized PNG output")
	flag.Parse()
	if *rawPath == "" || *canonicalPath == "" {
		fmt.Fprintln(os.Stderr, "raw and canonical outputs are required")
		os.Exit(2)
	}
	raw, canonical, manifest, err := buildFixture()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*rawPath, raw, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*canonicalPath, canonical, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(manifest); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func buildFixture() ([]byte, []byte, fixtureManifest, error) {
	const width, height = 120, 80
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.SetRGBA(x, y, color.RGBA{
				R: uint8(20 + x*170/(width-1)),
				G: uint8(30 + y*160/(height-1)),
				B: uint8(40 + (x+y)*120/(width+height-2)),
				A: 0xff,
			})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 94}); err != nil {
		return nil, nil, fixtureManifest{}, err
	}
	raw := injectOrientation6(encoded.Bytes())
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, nil, fixtureManifest{}, err
	}
	canonicalImage := image.NewNRGBA(image.Rect(0, 0, height, width))
	for y := 0; y < width; y++ {
		for x := 0; x < height; x++ {
			canonicalImage.Set(x, y, decoded.At(y, height-1-x))
		}
	}
	var canonicalBuffer bytes.Buffer
	if err := png.Encode(&canonicalBuffer, canonicalImage); err != nil {
		return nil, nil, fixtureManifest{}, err
	}
	canonical := canonicalBuffer.Bytes()
	canonicalDecoded, _, err := image.Decode(bytes.NewReader(canonical))
	if err != nil {
		return nil, nil, fixtureManifest{}, err
	}
	rawDigest := sha256.Sum256(raw)
	canonicalDigest := sha256.Sum256(canonical)
	aggregate := sha256.New()
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(canonical)))
	_, _ = aggregate.Write(length[:])
	_, _ = aggregate.Write(canonical)
	manifest := fixtureManifest{
		RawSHA256:             hex.EncodeToString(rawDigest[:]),
		RawSizeBytes:          len(raw),
		EncodedWidth:          width,
		EncodedHeight:         height,
		CanonicalSHA256:       hex.EncodeToString(canonicalDigest[:]),
		CanonicalAggregateSHA: hex.EncodeToString(aggregate.Sum(nil)),
		CanonicalSizeBytes:    len(canonical),
		CanonicalWidth:        height,
		CanonicalHeight:       width,
		CornerSamples: map[string][4]uint32{
			"top_left":     rgba(canonicalDecoded.At(0, 0)),
			"top_right":    rgba(canonicalDecoded.At(height-1, 0)),
			"bottom_left":  rgba(canonicalDecoded.At(0, width-1)),
			"bottom_right": rgba(canonicalDecoded.At(height-1, width-1)),
		},
	}
	return raw, canonical, manifest, nil
}

func injectOrientation6(encoded []byte) []byte {
	tiff := make([]byte, 26)
	copy(tiff[0:2], "II")
	binary.LittleEndian.PutUint16(tiff[2:4], 42)
	binary.LittleEndian.PutUint32(tiff[4:8], 8)
	binary.LittleEndian.PutUint16(tiff[8:10], 1)
	binary.LittleEndian.PutUint16(tiff[10:12], 0x0112)
	binary.LittleEndian.PutUint16(tiff[12:14], 3)
	binary.LittleEndian.PutUint32(tiff[14:18], 1)
	binary.LittleEndian.PutUint16(tiff[18:20], 6)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	segmentLength := len(payload) + 2
	segment := []byte{0xff, 0xe1, byte(segmentLength >> 8), byte(segmentLength)}
	segment = append(segment, payload...)
	result := make([]byte, 0, len(encoded)+len(segment))
	result = append(result, encoded[:2]...)
	result = append(result, segment...)
	return append(result, encoded[2:]...)
}

func rgba(value color.Color) [4]uint32 {
	r, g, b, a := value.RGBA()
	return [4]uint32{r >> 8, g >> 8, b >> 8, a >> 8}
}
