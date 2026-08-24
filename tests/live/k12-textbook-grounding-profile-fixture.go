package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/hexagon-codes/hexclaw/config"
)

const (
	expectedProvider       = "hexclaw-gpt"
	expectedModel          = "gpt-5.6-sol"
	expectedEmbeddingModel = "qwen3-embedding:8b"
)

type fixtureReceipt struct {
	Status                string `json:"status"`
	Provider              string `json:"provider"`
	Model                 string `json:"model"`
	EmbeddingProvider     string `json:"embedding_provider"`
	EmbeddingModel        string `json:"embedding_model"`
	EmbeddingProtocol     string `json:"embedding_protocol"`
	EmbeddingDimension    int    `json:"embedding_dimension"`
	EmbeddingProfileHash  string `json:"embedding_profile_hash"`
	DingTalkEnabled       bool   `json:"dingtalk_enabled"`
	DirectDatabaseTouched bool   `json:"direct_database_touched"`
}

type fixtureEmbeddingSelection struct {
	Provider  string
	Executor  config.LLMProviderConfig
	Spec      config.LLMProviderModelSpec
	Knowledge config.KnowledgeConfig
}

func main() {
	var sourceConfig string
	var targetConfig string
	var storePath string
	var profileRoot string
	var port int
	flag.StringVar(&sourceConfig, "source-config", "", "")
	flag.StringVar(&targetConfig, "target-config", "", "")
	flag.StringVar(&storePath, "store", "", "")
	flag.StringVar(&profileRoot, "profile", "", "")
	flag.IntVar(&port, "port", 0, "")
	flag.Parse()

	if err := prepare(sourceConfig, targetConfig, storePath, profileRoot, port); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "PROFILE_PREPARE_FAILED")
		os.Exit(1)
	}
}

func prepare(sourceConfig, targetConfig, storePath, profileRoot string, port int) error {
	if strings.TrimSpace(sourceConfig) == "" || strings.TrimSpace(targetConfig) == "" ||
		strings.TrimSpace(storePath) == "" || strings.TrimSpace(profileRoot) == "" ||
		port < 1024 || port >= 65534 {
		return fmt.Errorf("invalid fixture arguments")
	}
	if err := requirePrivateRegularFile(sourceConfig); err != nil {
		return err
	}
	if err := requirePrivateDirectory(profileRoot); err != nil {
		return err
	}

	source, err := config.Load(sourceConfig)
	if err != nil {
		return fmt.Errorf("source config unavailable")
	}
	visionProvider, ok := source.LLM.Providers[expectedProvider]
	if !ok || !providerHasModel(visionProvider, expectedModel) ||
		!config.ModelHasCapabilities(
			visionProvider, expectedModel,
			config.LLMModelCapabilityText, config.LLMModelCapabilityVision,
		) || (strings.TrimSpace(visionProvider.APIKey) == "" &&
		strings.TrimSpace(visionProvider.CredentialRef) == "") {
		return fmt.Errorf("exact model credential unavailable")
	}
	embedding, err := selectFixtureEmbedding(source)
	if err != nil {
		return err
	}

	prepared := config.DefaultConfig()
	prepared.Server.Host = "127.0.0.1"
	prepared.Server.Port = port
	prepared.Server.MCPPort = port + 1
	prepared.Server.APIToken = ""
	prepared.Storage.Driver = "sqlite"
	prepared.Storage.SQLite.Path = storePath
	prepared.Platforms = config.PlatformsConfig{Web: config.WebConfig{Enabled: true}}
	prepared.Heartbeat.Enabled = false
	prepared.Cron.Enabled = false
	prepared.Webhook.Enabled = false
	prepared.MCP.Enabled = false
	prepared.Voice.Enabled = false
	prepared.Compaction.Enabled = false
	prepared.FileMemory.Enabled = false
	prepared.FileMemory.Dir = filepath.Join(profileRoot, "memory")
	prepared.Memory.LongTerm.Enabled = false
	prepared.Memory.Vector.Enabled = false
	prepared.Router.Enabled = true
	prepared.Router.DefaultAgent = ""
	prepared.Router.LLMFallback = false
	prepared.Router.Agents = nil
	prepared.Router.Rules = nil
	prepared.ResourceGovernor.VLMConcurrency = 1
	prepared.ResourceGovernor.AcceleratorConcurrency = 1
	prepared.ResourceGovernor.CPUHeavyConcurrency = 1
	prepared.ResourceGovernor.SQLiteWriteConcurrency = 1
	prepared.ResourceGovernor.MaxInteractiveBurst = 1

	// 只复制真实批改模型与真实 embedding 执行器，禁止其它模型成为隐式回退。
	prepared.LLM = source.LLM
	prepared.LLM.Default = expectedProvider
	prepared.LLM.ReasoningProvider = expectedProvider
	prepared.LLM.ReasoningModel = expectedModel
	prepared.LLM.DefaultReasoningPolicy = config.ReasoningPolicy{
		Mode: config.ReasoningPolicyModeEffort, Effort: config.ReasoningEffortLow,
	}
	prepared.LLM.Routing.Enabled = false
	prepared.LLM.Cache.Enabled = false
	projectedVision, err := projectProvider(visionProvider, expectedModel)
	if err != nil {
		return err
	}
	projectedEmbedding, err := projectEmbeddingProvider(embedding.Executor)
	if err != nil {
		return err
	}
	prepared.LLM.Providers = map[string]config.LLMProviderConfig{
		expectedProvider:   projectedVision,
		embedding.Provider: projectedEmbedding,
	}
	prepared.Knowledge = embedding.Knowledge
	prepared.Knowledge.Enabled = true
	prepared.K12 = source.K12
	if prepared.K12.GradingBudget.IsZero() {
		prepared.K12.GradingBudget = fixtureGradingBudget()
	}
	if err := prepared.Validate(); err != nil {
		return fmt.Errorf("isolated config invalid")
	}
	if err := os.MkdirAll(filepath.Dir(targetConfig), 0o700); err != nil {
		return fmt.Errorf("target config directory unavailable")
	}
	if err := config.Save(prepared, targetConfig); err != nil {
		return fmt.Errorf("target config save failed")
	}
	if err := os.Chmod(targetConfig, 0o600); err != nil {
		return fmt.Errorf("target config permission failed")
	}

	receipt := fixtureReceipt{
		Status:                "prepared",
		Provider:              expectedProvider,
		Model:                 expectedModel,
		EmbeddingProvider:     embedding.Provider,
		EmbeddingModel:        expectedEmbeddingModel,
		EmbeddingProtocol:     embedding.Spec.Embedding.Protocol,
		EmbeddingDimension:    embedding.Spec.Embedding.Dimension,
		EmbeddingProfileHash:  embeddingProfileHash(prepared.Knowledge),
		DingTalkEnabled:       false,
		DirectDatabaseTouched: false,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(receipt)
}

func selectFixtureEmbedding(source *config.Config) (fixtureEmbeddingSelection, error) {
	providerName := strings.TrimSpace(source.Knowledge.Embedding.Provider)
	model := strings.TrimSpace(source.Knowledge.Embedding.Model)
	if (providerName == "") != (model == "") {
		return fixtureEmbeddingSelection{}, fmt.Errorf("embedding profile unavailable")
	}

	if providerName == "" {
		for name, provider := range source.LLM.Providers {
			_, ok := exactFixtureEmbeddingCandidate(name, provider)
			if !ok {
				continue
			}
			if providerName != "" {
				return fixtureEmbeddingSelection{}, fmt.Errorf("embedding profile unavailable")
			}
			providerName = name
			model = expectedEmbeddingModel
		}
		if providerName == "" {
			return fixtureEmbeddingSelection{}, fmt.Errorf("embedding profile unavailable")
		}
	}
	if model != expectedEmbeddingModel {
		return fixtureEmbeddingSelection{}, fmt.Errorf("embedding profile unavailable")
	}

	executor, ok := source.LLM.Providers[providerName]
	if !ok {
		return fixtureEmbeddingSelection{}, fmt.Errorf("embedding executor unavailable")
	}
	spec, ok := exactFixtureEmbeddingCandidate(providerName, executor)
	if !ok {
		return fixtureEmbeddingSelection{}, fmt.Errorf("embedding model contract unavailable")
	}
	effectiveKnowledge := source.Knowledge
	effectiveKnowledge.Embedding.Provider = providerName
	effectiveKnowledge.Embedding.Model = expectedEmbeddingModel
	return fixtureEmbeddingSelection{
		Provider:  providerName,
		Executor:  executor,
		Spec:      spec,
		Knowledge: effectiveKnowledge,
	}, nil
}

func exactFixtureEmbeddingCandidate(
	providerName string,
	provider config.LLMProviderConfig,
) (config.LLMProviderModelSpec, bool) {
	if provider.Enabled != nil && !*provider.Enabled ||
		!strings.Contains(strings.ToLower(strings.TrimSpace(providerName)), "ollama") ||
		!config.IsLocalLLMProviderNamed(providerName, provider) ||
		!isLoopbackHTTPProvider(provider.BaseURL) ||
		!providerHasModel(provider, expectedEmbeddingModel) {
		return config.LLMProviderModelSpec{}, false
	}
	spec, ok := exactModelSpec(provider, expectedEmbeddingModel)
	if !ok || !config.ModelHasCapabilities(
		provider, expectedEmbeddingModel, config.LLMModelCapabilityEmbedding,
	) || spec.Embedding == nil ||
		spec.Embedding.Protocol != config.LLMEmbeddingProtocolOllama ||
		spec.Embedding.Dimension != 4096 {
		return config.LLMProviderModelSpec{}, false
	}
	return spec, true
}

func isLoopbackHTTPProvider(baseURL string) bool {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(endpoint.Hostname()), ".")
	if host == "localhost" {
		return true
	}
	if zone := strings.LastIndexByte(host, '%'); zone >= 0 {
		host = host[:zone]
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func exactModelSpec(
	provider config.LLMProviderConfig,
	model string,
) (config.LLMProviderModelSpec, bool) {
	for _, spec := range provider.ModelSpecs {
		if strings.TrimSpace(spec.ID) == model {
			return spec, true
		}
	}
	return config.LLMProviderModelSpec{}, false
}

func providerHasModel(provider config.LLMProviderConfig, model string) bool {
	if strings.TrimSpace(provider.Model) == model {
		return true
	}
	for _, candidate := range provider.Models {
		if strings.TrimSpace(candidate) == model {
			return true
		}
	}
	for _, candidate := range provider.ModelSpecs {
		if strings.TrimSpace(candidate.ID) == model {
			return true
		}
	}
	return false
}

func projectProvider(
	provider config.LLMProviderConfig,
	model string,
) (config.LLMProviderConfig, error) {
	projected := provider
	projected.Model = model
	projected.Models = []string{model}
	projected.ModelSpecsMode = "explicit"
	projected.ModelSpecs = nil
	for _, spec := range provider.ModelSpecs {
		if strings.TrimSpace(spec.ID) == model {
			projected.ModelSpecs = append(projected.ModelSpecs, spec)
		}
	}
	if len(projected.ModelSpecs) != 1 {
		return config.LLMProviderConfig{}, fmt.Errorf("provider model spec unavailable")
	}
	return projected, nil
}

func projectEmbeddingProvider(
	provider config.LLMProviderConfig,
) (config.LLMProviderConfig, error) {
	projected := provider
	projected.Model = ""
	projected.Models = []string{expectedEmbeddingModel}
	projected.ModelSpecsMode = config.LLMModelSpecsModeExplicit
	projected.ModelSpecs = nil
	for _, spec := range provider.ModelSpecs {
		if strings.TrimSpace(spec.ID) == expectedEmbeddingModel {
			projected.ModelSpecs = append(projected.ModelSpecs, spec)
		}
	}
	if len(projected.ModelSpecs) != 1 {
		return config.LLMProviderConfig{}, fmt.Errorf("provider model spec unavailable")
	}
	return projected, nil
}

func embeddingProfileHash(knowledge config.KnowledgeConfig) string {
	canonical := strings.Join([]string{
		strings.TrimSpace(knowledge.Embedding.Provider),
		strings.TrimSpace(knowledge.Embedding.Model),
		knowledge.Embedding.QueryPrefix,
		knowledge.Embedding.DocPrefix,
		fmt.Sprintf("%t", knowledge.Embedding.DisableAutoInstall),
	}, "\x00")
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:])
}

func fixtureGradingBudget() config.K12GradingBudgetConfig {
	return config.K12GradingBudgetConfig{
		PolicyVersion: 1, QueuedSeconds: 600, NormalizingSeconds: 600,
		RecognizingSeconds: 600, LocatingSeconds: 600, RenderingSeconds: 600,
		ProjectingSeconds: 600, RecognitionPlanVersion: 1, ItemConcurrency: 1,
		AssessingBuckets: []config.K12AssessingBudgetBucketConfig{
			{MaxProblems: 1, Seconds: 600},
			{MaxProblems: 8, Seconds: 600},
			{MaxProblems: 16, Seconds: 600},
			{MaxProblems: 32, Seconds: 600},
		},
	}
}

func requirePrivateRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm() != 0o600 {
		return fmt.Errorf("source config permission invalid")
	}
	return nil
}

func requirePrivateDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("profile directory permission invalid")
	}
	return nil
}
