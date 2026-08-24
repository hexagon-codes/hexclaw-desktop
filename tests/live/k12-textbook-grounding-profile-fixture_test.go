package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/hexagon-codes/hexclaw/config"
)

const fixtureEmbeddingProvider = "Ollama (本地)"

func TestPrepareSelectsUniqueLocalOllamaEmbeddingWithoutWritingOwnerConfig(t *testing.T) {
	clearFixtureProviderEnvironment(t)
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatalf("chmod fixture root: %v", err)
	}

	owner := fixtureOwnerConfig()
	owner.Knowledge.Embedding.Provider = ""
	owner.Knowledge.Embedding.Model = ""
	ownerPath := filepath.Join(root, "owner.yaml")
	targetPath := filepath.Join(root, "isolated.yaml")
	storePath := filepath.Join(root, "data.db")
	if err := config.Save(owner, ownerPath); err != nil {
		t.Fatalf("save owner config: %v", err)
	}
	before, err := os.ReadFile(ownerPath)
	if err != nil {
		t.Fatalf("read owner config before prepare: %v", err)
	}

	receiptBytes, err := capturePrepare(ownerPath, targetPath, storePath, root, 23061)
	if err != nil {
		t.Fatalf("prepare with unique local Ollama embedding: %v", err)
	}
	after, err := os.ReadFile(ownerPath)
	if err != nil {
		t.Fatalf("read owner config after prepare: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("owner config changed during isolated profile preparation")
	}

	prepared, err := config.Load(targetPath)
	if err != nil {
		t.Fatalf("load isolated config: %v", err)
	}
	if got := prepared.Knowledge.Embedding.Provider; got != fixtureEmbeddingProvider {
		t.Fatalf("effective embedding provider = %q, want %q", got, fixtureEmbeddingProvider)
	}
	if got := prepared.Knowledge.Embedding.Model; got != expectedEmbeddingModel {
		t.Fatalf("effective embedding model = %q, want %q", got, expectedEmbeddingModel)
	}

	var receipt fixtureReceipt
	if err := json.Unmarshal(receiptBytes, &receipt); err != nil {
		t.Fatalf("decode fixture receipt: %v", err)
	}
	if receipt.EmbeddingProvider != fixtureEmbeddingProvider ||
		receipt.EmbeddingModel != expectedEmbeddingModel {
		t.Fatalf("receipt embedding selector = %q/%q", receipt.EmbeddingProvider, receipt.EmbeddingModel)
	}
	wantHash := embeddingProfileHash(prepared.Knowledge)
	if receipt.EmbeddingProfileHash != wantHash {
		t.Fatalf("receipt embedding hash = %q, want effective hash %q", receipt.EmbeddingProfileHash, wantHash)
	}
	if receipt.EmbeddingProfileHash == embeddingProfileHash(owner.Knowledge) {
		t.Fatal("receipt hash used the empty owner selector instead of effective Knowledge")
	}
}

func TestPrepareEmbeddingAutoselectionFailsClosed(t *testing.T) {
	clearFixtureProviderEnvironment(t)
	tests := []struct {
		name   string
		mutate func(*config.Config)
	}{
		{
			name: "no candidate",
			mutate: func(owner *config.Config) {
				delete(owner.LLM.Providers, fixtureEmbeddingProvider)
			},
		},
		{
			name: "multiple candidates",
			mutate: func(owner *config.Config) {
				owner.LLM.Providers["Ollama (本地) duplicate"] = fixtureEmbeddingExecutor()
			},
		},
		{
			name: "provider only selector",
			mutate: func(owner *config.Config) {
				owner.Knowledge.Embedding.Provider = fixtureEmbeddingProvider
			},
		},
		{
			name: "model only selector",
			mutate: func(owner *config.Config) {
				owner.Knowledge.Embedding.Model = expectedEmbeddingModel
			},
		},
		{
			name: "disabled candidate",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				provider.Enabled = fixtureBool(false)
				owner.LLM.Providers[fixtureEmbeddingProvider] = provider
			},
		},
		{
			name: "cloud candidate",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				provider.Locality = config.ProviderLocalityCloud
				owner.LLM.Providers[fixtureEmbeddingProvider] = provider
			},
		},
		{
			name: "non loopback candidate",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				provider.BaseURL = "http://192.0.2.10:11434/v1"
				owner.LLM.Providers[fixtureEmbeddingProvider] = provider
			},
		},
		{
			name: "non Ollama provider",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				delete(owner.LLM.Providers, fixtureEmbeddingProvider)
				owner.LLM.Providers["local embeddings"] = provider
			},
		},
		{
			name: "wrong protocol",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				provider.ModelSpecs[0].Embedding.Protocol = config.LLMEmbeddingProtocolOpenAI
				owner.LLM.Providers[fixtureEmbeddingProvider] = provider
			},
		},
		{
			name: "wrong dimension",
			mutate: func(owner *config.Config) {
				provider := owner.LLM.Providers[fixtureEmbeddingProvider]
				provider.ModelSpecs[0].Embedding.Dimension = 1024
				owner.LLM.Providers[fixtureEmbeddingProvider] = provider
			},
		},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0o700); err != nil {
				t.Fatalf("chmod fixture root: %v", err)
			}
			owner := fixtureOwnerConfig()
			test.mutate(owner)
			ownerPath := filepath.Join(root, "owner.yaml")
			if err := config.Save(owner, ownerPath); err != nil {
				t.Fatalf("save owner config: %v", err)
			}
			_, err := capturePrepare(
				ownerPath,
				filepath.Join(root, "isolated.yaml"),
				filepath.Join(root, "data.db"),
				root,
				23100+index,
			)
			if err == nil {
				t.Fatal("invalid embedding selection unexpectedly prepared")
			}
		})
	}
}

func fixtureOwnerConfig() *config.Config {
	owner := config.DefaultConfig()
	owner.LLM.Default = expectedProvider
	owner.LLM.ReasoningProvider = expectedProvider
	owner.LLM.ReasoningModel = expectedModel
	owner.LLM.DefaultReasoningPolicy = config.ReasoningPolicy{
		Mode: config.ReasoningPolicyModeEffort, Effort: config.ReasoningEffortLow,
	}
	owner.LLM.Providers = map[string]config.LLMProviderConfig{
		expectedProvider: {
			APIKey:         "fixture-key",
			Model:          expectedModel,
			Models:         []string{expectedModel},
			ModelSpecsMode: config.LLMModelSpecsModeExplicit,
			ModelSpecs: []config.LLMProviderModelSpec{{
				ID: expectedModel,
				Capabilities: []string{
					config.LLMModelCapabilityText,
					config.LLMModelCapabilityVision,
				},
				ReasoningSupport: config.LLMReasoningSupportSupported,
				ReasoningControl: &config.LLMReasoningControlSpec{
					Dialect: config.LLMReasoningDialectEffort,
					On:      string(config.ReasoningEffortLow), Off: "none",
					AllowedEfforts: []string{string(config.ReasoningEffortLow)},
				},
			}},
		},
		fixtureEmbeddingProvider: fixtureEmbeddingExecutor(),
	}
	owner.Knowledge.Enabled = true
	owner.Knowledge.Embedding.Provider = ""
	owner.Knowledge.Embedding.Model = ""
	owner.Knowledge.Embedding.QueryPrefix = "query: "
	owner.Knowledge.Embedding.DocPrefix = "document: "
	owner.Knowledge.Embedding.DisableAutoInstall = true
	return owner
}

func fixtureEmbeddingExecutor() config.LLMProviderConfig {
	return config.LLMProviderConfig{
		BaseURL:        "http://localhost:11434/v1",
		Locality:       config.ProviderLocalityLocal,
		Enabled:        fixtureBool(true),
		Models:         []string{expectedEmbeddingModel},
		ModelSpecsMode: config.LLMModelSpecsModeExplicit,
		ModelSpecs: []config.LLMProviderModelSpec{{
			ID:               expectedEmbeddingModel,
			Capabilities:     []string{config.LLMModelCapabilityEmbedding},
			ReasoningSupport: config.LLMReasoningSupportUnknown,
			Embedding: &config.LLMEmbeddingModelSpec{
				Protocol:  config.LLMEmbeddingProtocolOllama,
				Dimension: 4096,
			},
		}},
	}
}

func fixtureBool(value bool) *bool {
	return &value
}

func clearFixtureProviderEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "QWEN_API_KEY", "GEMINI_API_KEY",
	} {
		t.Setenv(name, "")
	}
}

func capturePrepare(
	sourceConfig, targetConfig, storePath, profileRoot string,
	port int,
) ([]byte, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	previous := os.Stdout
	os.Stdout = writer
	prepareErr := prepare(sourceConfig, targetConfig, storePath, profileRoot, port)
	closeErr := writer.Close()
	os.Stdout = previous
	output, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if prepareErr != nil {
		return output, prepareErr
	}
	if closeErr != nil {
		return output, closeErr
	}
	return output, readErr
}
