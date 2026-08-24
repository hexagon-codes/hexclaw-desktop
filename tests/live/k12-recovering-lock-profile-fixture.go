package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/hexagon-codes/hexclaw/config"
)

const (
	fixtureProvider = "recovery-fixture"
	fixtureModel    = "fixture-vision"
)

type receipt struct {
	Status                string `json:"status"`
	Provider              string `json:"provider"`
	Model                 string `json:"model"`
	ConfigSHA256          string `json:"config_sha256"`
	EndpointSHA256        string `json:"endpoint_sha256"`
	DingTalkEnabled       bool   `json:"dingtalk_enabled"`
	DirectDatabaseTouched bool   `json:"direct_database_touched"`
}

func main() {
	var targetConfig string
	var storePath string
	var profileRoot string
	var endpoint string
	var port int
	flag.StringVar(&targetConfig, "target-config", "", "")
	flag.StringVar(&storePath, "store", "", "")
	flag.StringVar(&profileRoot, "profile", "", "")
	flag.StringVar(&endpoint, "endpoint", "", "")
	flag.IntVar(&port, "port", 0, "")
	flag.Parse()

	if err := prepare(targetConfig, storePath, profileRoot, endpoint, port); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "PROFILE_PREPARE_FAILED")
		os.Exit(1)
	}
}

func prepare(targetConfig, storePath, profileRoot, endpoint string, port int) error {
	if strings.TrimSpace(targetConfig) == "" || strings.TrimSpace(storePath) == "" ||
		strings.TrimSpace(profileRoot) == "" || strings.TrimSpace(endpoint) == "" ||
		port < 1024 || port > 65533 {
		return fmt.Errorf("invalid fixture arguments")
	}
	if err := requirePrivateDirectory(profileRoot); err != nil {
		return err
	}
	if err := requirePrivateRegularFile(storePath); err != nil {
		return err
	}

	providerID, err := config.NewProviderInstanceID()
	if err != nil {
		return fmt.Errorf("provider identity unavailable")
	}
	disabled := false
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
	prepared.Knowledge.Enabled = false
	prepared.Router.Enabled = true
	prepared.Router.DefaultAgent = ""
	prepared.Router.LLMFallback = false
	prepared.Router.Agents = nil
	prepared.Router.Rules = nil
	prepared.LLM.Default = fixtureProvider
	prepared.LLM.ReasoningProvider = ""
	prepared.LLM.ReasoningModel = ""
	prepared.LLM.Routing.Enabled = false
	prepared.LLM.Cache.Enabled = false
	prepared.LLM.Providers = map[string]config.LLMProviderConfig{
		fixtureProvider: {
			ProviderInstanceID: providerID,
			DisplayName:        "Recovery Fixture",
			APIKey:             "test-only-not-a-secret",
			BaseURL:            endpoint,
			Model:              fixtureModel,
			Models:             []string{fixtureModel},
			ModelSpecsMode:     config.LLMModelSpecsModeExplicit,
			ModelSpecs: []config.LLMProviderModelSpec{{
				ID: fixtureModel,
				Capabilities: []string{
					config.LLMModelCapabilityText,
					config.LLMModelCapabilityVision,
				},
				ReasoningSupport: config.LLMReasoningSupportUnsupported,
			}},
			Compatible:     "openai",
			Locality:       config.ProviderLocalityCloud,
			LocalitySource: "system",
			ToolsEnabled:   &disabled,
		},
	}
	prepared.K12.GradingBudget = gradingBudget()
	prepared.ResourceGovernor.VLMConcurrency = 1
	prepared.ResourceGovernor.AcceleratorConcurrency = 1
	prepared.ResourceGovernor.CPUHeavyConcurrency = 1
	prepared.ResourceGovernor.SQLiteWriteConcurrency = 1
	prepared.ResourceGovernor.MaxInteractiveBurst = 1
	if err := prepared.Validate(); err != nil {
		return fmt.Errorf("isolated config invalid")
	}
	if err := os.MkdirAll(filepath.Dir(targetConfig), 0o700); err != nil {
		return fmt.Errorf("config directory unavailable")
	}
	if err := config.Save(prepared, targetConfig); err != nil {
		return fmt.Errorf("config save failed")
	}
	if err := os.Chmod(targetConfig, 0o600); err != nil {
		return fmt.Errorf("config permission failed")
	}
	raw, err := os.ReadFile(targetConfig)
	if err != nil {
		return fmt.Errorf("config receipt unavailable")
	}
	configDigest := sha256.Sum256(raw)
	endpointDigest := sha256.Sum256([]byte(endpoint))
	return json.NewEncoder(os.Stdout).Encode(receipt{
		Status:                "prepared",
		Provider:              fixtureProvider,
		Model:                 fixtureModel,
		ConfigSHA256:          fmt.Sprintf("%x", configDigest[:]),
		EndpointSHA256:        fmt.Sprintf("%x", endpointDigest[:]),
		DingTalkEnabled:       false,
		DirectDatabaseTouched: false,
	})
}

func requirePrivateDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		return fmt.Errorf("profile directory invalid")
	}
	return nil
}

func requirePrivateRegularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return fmt.Errorf("private file invalid")
	}
	return nil
}

func gradingBudget() config.K12GradingBudgetConfig {
	return config.K12GradingBudgetConfig{
		PolicyVersion: 1,
		QueuedSeconds: 300, NormalizingSeconds: 300, RecognizingSeconds: 300,
		LocatingSeconds: 300, RenderingSeconds: 300, ProjectingSeconds: 300,
		RecognitionPlanVersion: 1, ItemConcurrency: 1,
		AssessingBuckets: []config.K12AssessingBudgetBucketConfig{
			{MaxProblems: 1, Seconds: 300},
			{MaxProblems: 8, Seconds: 300},
			{MaxProblems: 16, Seconds: 300},
			{MaxProblems: 32, Seconds: 300},
		},
	}
}
