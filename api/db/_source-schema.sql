--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_commands (
    id integer NOT NULL,
    license_id integer NOT NULL,
    company_id integer,
    type character varying(255) NOT NULL,
    payload text,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    result text,
    error text,
    created_by integer,
    picked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: agent_commands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_commands_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_commands_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_commands_id_seq OWNED BY public.agent_commands.id;


--
-- Name: agent_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_releases (
    id integer NOT NULL,
    version character varying(255) NOT NULL,
    filename character varying(255) NOT NULL,
    sha256 character varying(255),
    notes text,
    mandatory boolean DEFAULT false NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    size_bytes bigint,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: agent_releases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_releases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_releases_id_seq OWNED BY public.agent_releases.id;


--
-- Name: app_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_releases (
    id integer NOT NULL,
    version character varying(255) NOT NULL,
    version_code integer DEFAULT 0 NOT NULL,
    filename character varying(255) NOT NULL,
    sha256 character varying(255),
    notes text,
    mandatory boolean DEFAULT false NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    size_bytes bigint,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: app_releases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_releases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_releases_id_seq OWNED BY public.app_releases.id;


--
-- Name: bank_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_transactions (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    txn_date date,
    description text,
    reference character varying(191),
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    direction text,
    status text DEFAULT 'unmatched'::text NOT NULL,
    matched_type text,
    matched_id bigint,
    matched_at timestamp with time zone,
    batch character varying(60),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: bank_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bank_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bank_transactions_id_seq OWNED BY public.bank_transactions.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    parent_id bigint,
    status text DEFAULT 'Active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id bigint NOT NULL,
    name character varying(191) NOT NULL,
    slug character varying(120) NOT NULL,
    email character varying(191),
    mobile character varying(30),
    gst_number character varying(30),
    pan_number character varying(20),
    logo text,
    address text,
    financial_year character varying(20),
    status text DEFAULT 'Active'::text NOT NULL,
    subscription_plan character varying(60),
    subscription_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    license_id bigint,
    max_sessions_per_user integer DEFAULT 1 NOT NULL,
    tally_guid character varying(100),
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    mailing_name character varying(255),
    state character varying(255),
    country character varying(255),
    pincode character varying(255),
    phone character varying(255),
    books_from character varying(255),
    tally_dirty boolean DEFAULT false NOT NULL
);


--
-- Name: companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.companies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: companies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.companies_id_seq OWNED BY public.companies.id;


--
-- Name: customer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_groups (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: customer_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_groups_id_seq OWNED BY public.customer_groups.id;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    location_id bigint,
    sales_person_id bigint,
    customer_group_id bigint,
    name character varying(191) NOT NULL,
    mobile character varying(30),
    alternate_mobile character varying(30),
    email character varying(191),
    gst_number character varying(30),
    pan_number character varying(20),
    billing_address text,
    shipping_address text,
    opening_balance numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    credit_limit numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    is_tally_ledger boolean DEFAULT true NOT NULL,
    tally_guid character varying(100),
    tally_synced_at timestamp with time zone,
    notes text,
    internal_remarks text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    tally_dirty boolean DEFAULT false NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    geo_radius_m integer
);


--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;


--
-- Name: einvoice_api_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_api_logs (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint,
    provider text NOT NULL,
    env text NOT NULL,
    action text NOT NULL,
    endpoint text,
    http_status integer,
    nic_status_code character varying(20),
    success boolean DEFAULT false NOT NULL,
    latency_ms integer,
    request jsonb,
    response jsonb,
    error text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_api_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_api_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_api_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_api_logs_id_seq OWNED BY public.einvoice_api_logs.id;


--
-- Name: einvoice_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_audit_logs (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint,
    action text NOT NULL,
    actor_id bigint,
    actor_name character varying(191),
    ip character varying(64),
    before jsonb,
    after jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_audit_logs_id_seq OWNED BY public.einvoice_audit_logs.id;


--
-- Name: einvoice_cancellation_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_cancellation_history (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint NOT NULL,
    kind text NOT NULL,
    doc_ref character varying(128),
    reason_code text,
    remarks text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_cancellation_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_cancellation_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_cancellation_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_cancellation_history_id_seq OWNED BY public.einvoice_cancellation_history.id;


--
-- Name: einvoice_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_jobs (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint,
    type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_run_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_error text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_jobs_id_seq OWNED BY public.einvoice_jobs.id;


--
-- Name: einvoice_print_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_print_logs (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint NOT NULL,
    template text,
    doc_type text,
    channel text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_print_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_print_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_print_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_print_logs_id_seq OWNED BY public.einvoice_print_logs.id;


--
-- Name: einvoice_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_settings (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    default_provider text DEFAULT 'nic'::text NOT NULL,
    env text DEFAULT 'sandbox'::text NOT NULL,
    auto_generate boolean DEFAULT false NOT NULL,
    auto_eway boolean DEFAULT false NOT NULL,
    auto_distance boolean DEFAULT true NOT NULL,
    updated_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_settings_id_seq OWNED BY public.einvoice_settings.id;


--
-- Name: einvoice_transport_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_transport_history (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint NOT NULL,
    ewb_no character varying(30),
    vehicle_no character varying(30),
    from_place text,
    transport_mode text,
    reason_code text,
    remarks text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_transport_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_transport_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_transport_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_transport_history_id_seq OWNED BY public.einvoice_transport_history.id;


--
-- Name: einvoice_validity_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoice_validity_history (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    einvoice_id bigint NOT NULL,
    ewb_no character varying(30),
    extended_until timestamp with time zone,
    remaining_distance numeric(10,2),
    reason_code text,
    remarks text,
    vehicle_no character varying(30),
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: einvoice_validity_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoice_validity_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoice_validity_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoice_validity_history_id_seq OWNED BY public.einvoice_validity_history.id;


--
-- Name: einvoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.einvoices (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    irn character varying(128),
    ack_no character varying(40),
    ack_date timestamp with time zone,
    qr_code text,
    ewb_no character varying(30),
    ewb_date date,
    ewb_valid_until timestamp with time zone,
    transporter character varying(191),
    transporter_id character varying(40),
    vehicle_no character varying(30),
    distance_km numeric(10,2),
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb,
    error text,
    generated_at timestamp with time zone,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    provider text DEFAULT 'nic'::text NOT NULL,
    env text DEFAULT 'sandbox'::text NOT NULL,
    gstin character varying(15),
    doc_type text DEFAULT 'INV'::text NOT NULL,
    supply_type text DEFAULT 'B2B'::text NOT NULL,
    irp_status text DEFAULT 'pending'::text NOT NULL,
    ewb_status text DEFAULT 'not_required'::text NOT NULL,
    signed_invoice text,
    signed_qr text,
    idempotency_key character varying(64),
    dedup_hash character varying(80),
    ewb_part text,
    transport_mode text,
    vehicle_type text,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    hsn_summary jsonb,
    tax_summary jsonb
);


--
-- Name: einvoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.einvoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: einvoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.einvoices_id_seq OWNED BY public.einvoices.id;


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_categories (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: expense_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expense_categories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expense_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expense_categories_id_seq OWNED BY public.expense_categories.id;


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    category_id bigint,
    vendor character varying(191),
    expense_date date,
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    payment_mode text,
    reference character varying(100),
    notes text,
    status text DEFAULT 'Active'::text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expenses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expenses_id_seq OWNED BY public.expenses.id;


--
-- Name: field_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_attendance (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    user_id bigint,
    day date NOT NULL,
    start_at timestamp with time zone,
    start_lat numeric(10,7),
    start_lng numeric(10,7),
    end_at timestamp with time zone,
    end_lat numeric(10,7),
    end_lng numeric(10,7),
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: field_attendance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.field_attendance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.field_attendance_id_seq OWNED BY public.field_attendance.id;


--
-- Name: field_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_locations (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    user_id bigint,
    lat numeric(10,7) NOT NULL,
    lng numeric(10,7) NOT NULL,
    source text NOT NULL,
    part_visit_id bigint,
    accuracy_m numeric(8,2),
    moved_m integer,
    captured_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: field_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.field_locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.field_locations_id_seq OWNED BY public.field_locations.id;


--
-- Name: field_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_visits (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    user_id bigint,
    customer_id bigint,
    location_id bigint,
    checkin_at timestamp with time zone NOT NULL,
    checkin_lat numeric(10,7),
    checkin_lng numeric(10,7),
    checkin_distance_m integer,
    checkin_within boolean DEFAULT false NOT NULL,
    checkout_at timestamp with time zone,
    checkout_lat numeric(10,7),
    checkout_lng numeric(10,7),
    note text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: field_visits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.field_visits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_visits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.field_visits_id_seq OWNED BY public.field_visits.id;


--
-- Name: gps_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gps_settings (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    gps_enabled boolean DEFAULT false NOT NULL,
    track_hourly boolean DEFAULT false NOT NULL,
    hourly_interval_min integer DEFAULT 60 NOT NULL,
    track_part_visit boolean DEFAULT true NOT NULL,
    track_on_create boolean DEFAULT false NOT NULL,
    time_from character varying(5) DEFAULT '07:00'::character varying NOT NULL,
    time_to character varying(5) DEFAULT '20:00'::character varying NOT NULL,
    min_move_m integer DEFAULT 100 NOT NULL,
    updated_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: gps_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gps_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gps_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gps_settings_id_seq OWNED BY public.gps_settings.id;


--
-- Name: gsp_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gsp_credentials (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    provider text NOT NULL,
    env text NOT NULL,
    gstin character varying(15),
    base_url text,
    username text,
    password_enc text,
    client_id_enc text,
    client_secret_enc text,
    api_key_enc text,
    extra_enc text,
    active boolean DEFAULT true NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: gsp_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gsp_credentials_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gsp_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gsp_credentials_id_seq OWNED BY public.gsp_credentials.id;


--
-- Name: gsp_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gsp_tokens (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    provider text NOT NULL,
    env text NOT NULL,
    gstin character varying(15),
    auth_token text,
    sek text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: gsp_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gsp_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gsp_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gsp_tokens_id_seq OWNED BY public.gsp_tokens.id;


--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    product_id bigint NOT NULL,
    location_id bigint,
    opening numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    purchased numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    sold numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    current_stock numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    value numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    reorder_level numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: inventory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventory_id_seq OWNED BY public.inventory.id;


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    product_id bigint,
    description text,
    hsn character varying(20),
    quantity numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    unit character varying(30),
    rate numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    discount_pct numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    taxable numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    gst_rate numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    gst_amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: invoice_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_items_id_seq OWNED BY public.invoice_items.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    type text NOT NULL,
    invoice_no character varying(60) NOT NULL,
    location_id bigint,
    customer_id bigint,
    supplier_id bigint,
    sales_person_id bigint,
    supplier_bill_no character varying(60),
    invoice_date date,
    due_date date,
    subtotal numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    discount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    taxable numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    cgst numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    sgst numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    igst numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    round_off numeric(8,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'pending_tally'::text NOT NULL,
    tally_voucher_no character varying(60),
    tally_guid character varying(100),
    pdf_path text,
    notes text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    tally_voucher_type character varying(64),
    tally_optional boolean DEFAULT false NOT NULL,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    approved_by bigint,
    approved_at timestamp with time zone,
    rejected_reason text
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: journals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journals (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    voucher_no character varying(40),
    journal_date date NOT NULL,
    dr_ledger character varying(191) NOT NULL,
    cr_ledger character varying(191) NOT NULL,
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    narration text,
    status text DEFAULT 'pending_tally'::text NOT NULL,
    tally_voucher_no character varying(60),
    tally_guid character varying(120),
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    vch_type character varying(30) DEFAULT 'Journal'::character varying NOT NULL
);


--
-- Name: journals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journals_id_seq OWNED BY public.journals.id;


--
-- Name: knex_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations (
    id integer NOT NULL,
    name character varying(255),
    batch integer,
    migration_time timestamp with time zone
);


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_id_seq OWNED BY public.knex_migrations.id;


--
-- Name: knex_migrations_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knex_migrations_lock (
    index integer NOT NULL,
    is_locked integer
);


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knex_migrations_lock_index_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knex_migrations_lock_index_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knex_migrations_lock_index_seq OWNED BY public.knex_migrations_lock.index;


--
-- Name: license_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.license_permissions (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    permission_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: license_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.license_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: license_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.license_permissions_id_seq OWNED BY public.license_permissions.id;


--
-- Name: licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.licenses (
    id bigint NOT NULL,
    license_key_hash character varying(128) NOT NULL,
    key_prefix character varying(40) NOT NULL,
    tally_serial character varying(60),
    holder_name character varying(191) NOT NULL,
    plan character varying(40) DEFAULT 'standard'::character varying NOT NULL,
    max_companies integer DEFAULT 5 NOT NULL,
    max_users integer DEFAULT 10 NOT NULL,
    valid_until date,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    machine_id character varying(191),
    machine_bound_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    agent_version character varying(40),
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    last_open_companies text,
    auto_update boolean DEFAULT true NOT NULL,
    sync_push_enabled boolean DEFAULT true NOT NULL,
    sync_pull_enabled boolean DEFAULT true NOT NULL,
    license_key_enc text,
    sync_enabled boolean DEFAULT true NOT NULL
);


--
-- Name: licenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.licenses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: licenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.licenses_id_seq OWNED BY public.licenses.id;


--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    code character varying(50),
    city character varying(100),
    state character varying(100),
    pincode character varying(12),
    mobile character varying(30),
    manager character varying(150),
    status text DEFAULT 'Active'::text NOT NULL,
    is_tally_godown boolean DEFAULT false NOT NULL,
    tally_guid character varying(100),
    tally_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    tally_dirty boolean DEFAULT false NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7)
);


--
-- Name: locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.locations_id_seq OWNED BY public.locations.id;


--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_reads (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    notification_key character varying(191) NOT NULL,
    read_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: notification_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_reads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_reads_id_seq OWNED BY public.notification_reads.id;


--
-- Name: part_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.part_visits (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    user_id bigint,
    location_id bigint,
    lat numeric(10,7),
    lng numeric(10,7),
    note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: part_visits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.part_visits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: part_visits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.part_visits_id_seq OWNED BY public.part_visits.id;


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id bigint NOT NULL,
    email character varying(191) NOT NULL,
    token character varying(191) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: password_resets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_resets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_resets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_resets_id_seq OWNED BY public.password_resets.id;


--
-- Name: payment_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_reminders (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    customer_id bigint,
    channel character varying(20) NOT NULL,
    to_address character varying(191),
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    trigger character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    offset_day integer,
    status character varying(20) DEFAULT 'sent'::character varying NOT NULL,
    error text,
    sent_by bigint,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: payment_reminders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_reminders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_reminders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_reminders_id_seq OWNED BY public.payment_reminders.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    type text NOT NULL,
    voucher_no character varying(60) NOT NULL,
    party_type text,
    customer_id bigint,
    supplier_id bigint,
    payment_date date,
    mode text,
    reference character varying(100),
    bank_account character varying(100),
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'pending_tally'::text NOT NULL,
    tally_voucher_no character varying(60),
    notes text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    tally_guid character varying(80),
    tally_optional boolean DEFAULT false NOT NULL
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id bigint NOT NULL,
    module character varying(60) NOT NULL,
    action character varying(20) NOT NULL,
    slug character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.permissions_id_seq OWNED BY public.permissions.id;


--
-- Name: product_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_images (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    product_id bigint NOT NULL,
    file_path character varying(255) NOT NULL,
    original_name character varying(191),
    size_bytes integer,
    mime character varying(60),
    sort_order integer DEFAULT 0 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: product_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_images_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_images_id_seq OWNED BY public.product_images.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    category_id bigint,
    name character varying(191) NOT NULL,
    sku character varying(100),
    unit character varying(30),
    hsn_code character varying(20),
    gst_rate numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    purchase_price numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    sales_price numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    opening_stock numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    is_tally_item boolean DEFAULT true NOT NULL,
    tally_guid character varying(100),
    tally_synced_at timestamp with time zone,
    description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    tally_dirty boolean DEFAULT false NOT NULL
);


--
-- Name: products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;


--
-- Name: record_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_history (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    module character varying(60) NOT NULL,
    record_type character varying(60),
    record_id bigint,
    action character varying(20) NOT NULL,
    source character varying(20) DEFAULT 'cloud'::character varying NOT NULL,
    before_json text,
    after_json text,
    changed_fields text,
    changed_by integer,
    note character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: record_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.record_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: record_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.record_history_id_seq OWNED BY public.record_history.id;


--
-- Name: recurring_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_invoices (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    customer_id bigint,
    title character varying(191) NOT NULL,
    description text,
    amount numeric(16,2) DEFAULT '0'::numeric NOT NULL,
    gst_rate numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    frequency text DEFAULT 'monthly'::text NOT NULL,
    due_days integer DEFAULT 0 NOT NULL,
    next_run_date date NOT NULL,
    start_date date,
    end_date date,
    status text DEFAULT 'Active'::text NOT NULL,
    last_invoice_id bigint,
    last_run_at timestamp with time zone,
    generated_count integer DEFAULT 0 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: recurring_invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recurring_invoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recurring_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recurring_invoices_id_seq OWNED BY public.recurring_invoices.id;


--
-- Name: reminder_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminder_settings (
    id bigint NOT NULL,
    license_id bigint NOT NULL,
    email_enabled boolean DEFAULT false NOT NULL,
    whatsapp_enabled boolean DEFAULT false NOT NULL,
    auto_enabled boolean DEFAULT false NOT NULL,
    offsets jsonb DEFAULT '[1, 7, 15]'::jsonb NOT NULL,
    send_hour integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: reminder_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reminder_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reminder_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reminder_settings_id_seq OWNED BY public.reminder_settings.id;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id bigint NOT NULL,
    role_id bigint NOT NULL,
    permission_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: role_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.role_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: role_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.role_permissions_id_seq OWNED BY public.role_permissions.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id bigint NOT NULL,
    company_id bigint,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    license_id bigint
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: sales_person_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_person_customers (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    customer_id bigint NOT NULL,
    location_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: sales_person_customers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_person_customers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_person_customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_person_customers_id_seq OWNED BY public.sales_person_customers.id;


--
-- Name: sales_person_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_person_locations (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    sales_person_id bigint NOT NULL,
    location_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: sales_person_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_person_locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_person_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_person_locations_id_seq OWNED BY public.sales_person_locations.id;


--
-- Name: sales_persons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_persons (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    user_id bigint,
    name character varying(150) NOT NULL,
    employee_code character varying(50),
    mobile character varying(30),
    email character varying(191),
    joining_date date,
    status text DEFAULT 'Active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: sales_persons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_persons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_persons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_persons_id_seq OWNED BY public.sales_persons.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    key character varying(120) NOT NULL,
    value jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.settings_id_seq OWNED BY public.settings.id;


--
-- Name: stock_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_adjustments (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    product_id bigint NOT NULL,
    location_id bigint,
    type character varying(10) NOT NULL,
    quantity numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    before_qty numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    after_qty numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    reason character varying(120),
    notes text,
    adjustment_date date,
    created_by bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: stock_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_adjustments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_adjustments_id_seq OWNED BY public.stock_adjustments.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    plan character varying(40) DEFAULT 'standard'::character varying NOT NULL,
    valid_from date NOT NULL,
    valid_until date NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    location_id bigint,
    supplier_group character varying(100),
    name character varying(191) NOT NULL,
    mobile character varying(30),
    alternate_mobile character varying(30),
    email character varying(191),
    gst_number character varying(30),
    pan_number character varying(20),
    opening_balance numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    payment_terms character varying(100),
    status text DEFAULT 'Active'::text NOT NULL,
    is_tally_ledger boolean DEFAULT true NOT NULL,
    tally_guid character varying(100),
    tally_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    tally_dirty boolean DEFAULT false NOT NULL,
    address text,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: suppliers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.suppliers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: suppliers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.suppliers_id_seq OWNED BY public.suppliers.id;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id integer NOT NULL,
    key character varying(120) NOT NULL,
    value jsonb,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: system_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;


--
-- Name: tally_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_groups (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    parent character varying(255),
    primary_group character varying(100),
    nature character varying(50),
    is_revenue boolean DEFAULT false,
    is_deemed_positive boolean DEFAULT true,
    tally_guid character varying(120),
    tally_alter_id bigint DEFAULT '0'::bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tally_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_groups_id_seq OWNED BY public.tally_groups.id;


--
-- Name: tally_inventory_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_inventory_entries (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    voucher_guid character varying(120) NOT NULL,
    voucher_date date,
    item_name character varying(255) NOT NULL,
    qty numeric(18,3) DEFAULT '0'::numeric,
    rate numeric(18,4) DEFAULT '0'::numeric,
    amount numeric(18,2) DEFAULT '0'::numeric,
    godown character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tally_inventory_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_inventory_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_inventory_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_inventory_entries_id_seq OWNED BY public.tally_inventory_entries.id;


--
-- Name: tally_ledgers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_ledgers (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    parent character varying(255),
    opening_balance numeric(18,2) DEFAULT '0'::numeric,
    closing_balance numeric(18,2) DEFAULT '0'::numeric,
    gstin character varying(30),
    gst_reg_type character varying(50),
    state character varying(100),
    address text,
    contact character varying(100),
    email character varying(255),
    bank_name character varying(255),
    bank_acc_no character varying(60),
    ifsc character varying(20),
    tally_guid character varying(120),
    tally_alter_id bigint DEFAULT '0'::bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tally_ledgers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_ledgers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_ledgers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_ledgers_id_seq OWNED BY public.tally_ledgers.id;


--
-- Name: tally_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_reports (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    report_type character varying(40) NOT NULL,
    payload jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tally_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_reports_id_seq OWNED BY public.tally_reports.id;


--
-- Name: tally_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_sync_logs (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    module character varying(60),
    record_type character varying(60),
    record_id bigint,
    direction text DEFAULT 'push'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    request_xml text,
    response_xml text,
    message text,
    retry_count integer DEFAULT 0 NOT NULL,
    synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tally_sync_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_sync_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_sync_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_sync_logs_id_seq OWNED BY public.tally_sync_logs.id;


--
-- Name: tally_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_sync_state (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    master_alter_id bigint DEFAULT '0'::bigint NOT NULL,
    voucher_alter_id bigint DEFAULT '0'::bigint NOT NULL,
    last_pull_at timestamp with time zone,
    last_push_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tally_sync_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_sync_state_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_sync_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_sync_state_id_seq OWNED BY public.tally_sync_state.id;


--
-- Name: tally_voucher_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tally_voucher_entries (
    id bigint NOT NULL,
    company_id bigint NOT NULL,
    voucher_guid character varying(120) NOT NULL,
    voucher_type character varying(100),
    voucher_no character varying(100),
    voucher_date date,
    ledger_name character varying(255) NOT NULL,
    amount numeric(18,2) NOT NULL,
    is_debit boolean,
    tally_alter_id bigint DEFAULT '0'::bigint,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tally_voucher_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tally_voucher_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tally_voucher_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tally_voucher_entries_id_seq OWNED BY public.tally_voucher_entries.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    jti character varying(64) NOT NULL,
    ip character varying(64),
    user_agent character varying(255),
    last_seen_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    company_id bigint,
    role_id bigint NOT NULL,
    location_id bigint,
    name character varying(150) NOT NULL,
    email character varying(191) NOT NULL,
    mobile character varying(30),
    password_hash character varying(255) NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    license_id bigint,
    current_company_id bigint,
    active_session_jti character varying(64),
    session_last_seen timestamp with time zone,
    session_expires_at timestamp with time zone,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by bigint
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: agent_commands id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commands ALTER COLUMN id SET DEFAULT nextval('public.agent_commands_id_seq'::regclass);


--
-- Name: agent_releases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_releases ALTER COLUMN id SET DEFAULT nextval('public.agent_releases_id_seq'::regclass);


--
-- Name: app_releases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases ALTER COLUMN id SET DEFAULT nextval('public.app_releases_id_seq'::regclass);


--
-- Name: bank_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_transactions ALTER COLUMN id SET DEFAULT nextval('public.bank_transactions_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: companies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies ALTER COLUMN id SET DEFAULT nextval('public.companies_id_seq'::regclass);


--
-- Name: customer_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups ALTER COLUMN id SET DEFAULT nextval('public.customer_groups_id_seq'::regclass);


--
-- Name: customers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);


--
-- Name: einvoice_api_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_api_logs ALTER COLUMN id SET DEFAULT nextval('public.einvoice_api_logs_id_seq'::regclass);


--
-- Name: einvoice_audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.einvoice_audit_logs_id_seq'::regclass);


--
-- Name: einvoice_cancellation_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_cancellation_history ALTER COLUMN id SET DEFAULT nextval('public.einvoice_cancellation_history_id_seq'::regclass);


--
-- Name: einvoice_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_jobs ALTER COLUMN id SET DEFAULT nextval('public.einvoice_jobs_id_seq'::regclass);


--
-- Name: einvoice_print_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_print_logs ALTER COLUMN id SET DEFAULT nextval('public.einvoice_print_logs_id_seq'::regclass);


--
-- Name: einvoice_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_settings ALTER COLUMN id SET DEFAULT nextval('public.einvoice_settings_id_seq'::regclass);


--
-- Name: einvoice_transport_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_transport_history ALTER COLUMN id SET DEFAULT nextval('public.einvoice_transport_history_id_seq'::regclass);


--
-- Name: einvoice_validity_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_validity_history ALTER COLUMN id SET DEFAULT nextval('public.einvoice_validity_history_id_seq'::regclass);


--
-- Name: einvoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices ALTER COLUMN id SET DEFAULT nextval('public.einvoices_id_seq'::regclass);


--
-- Name: expense_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories ALTER COLUMN id SET DEFAULT nextval('public.expense_categories_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses ALTER COLUMN id SET DEFAULT nextval('public.expenses_id_seq'::regclass);


--
-- Name: field_attendance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance ALTER COLUMN id SET DEFAULT nextval('public.field_attendance_id_seq'::regclass);


--
-- Name: field_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations ALTER COLUMN id SET DEFAULT nextval('public.field_locations_id_seq'::regclass);


--
-- Name: field_visits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits ALTER COLUMN id SET DEFAULT nextval('public.field_visits_id_seq'::regclass);


--
-- Name: gps_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gps_settings ALTER COLUMN id SET DEFAULT nextval('public.gps_settings_id_seq'::regclass);


--
-- Name: gsp_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_credentials ALTER COLUMN id SET DEFAULT nextval('public.gsp_credentials_id_seq'::regclass);


--
-- Name: gsp_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_tokens ALTER COLUMN id SET DEFAULT nextval('public.gsp_tokens_id_seq'::regclass);


--
-- Name: inventory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory ALTER COLUMN id SET DEFAULT nextval('public.inventory_id_seq'::regclass);


--
-- Name: invoice_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_items_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: journals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals ALTER COLUMN id SET DEFAULT nextval('public.journals_id_seq'::regclass);


--
-- Name: knex_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations ALTER COLUMN id SET DEFAULT nextval('public.knex_migrations_id_seq'::regclass);


--
-- Name: knex_migrations_lock index; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock ALTER COLUMN index SET DEFAULT nextval('public.knex_migrations_lock_index_seq'::regclass);


--
-- Name: license_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_permissions ALTER COLUMN id SET DEFAULT nextval('public.license_permissions_id_seq'::regclass);


--
-- Name: licenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses ALTER COLUMN id SET DEFAULT nextval('public.licenses_id_seq'::regclass);


--
-- Name: locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations ALTER COLUMN id SET DEFAULT nextval('public.locations_id_seq'::regclass);


--
-- Name: notification_reads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads ALTER COLUMN id SET DEFAULT nextval('public.notification_reads_id_seq'::regclass);


--
-- Name: part_visits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits ALTER COLUMN id SET DEFAULT nextval('public.part_visits_id_seq'::regclass);


--
-- Name: password_resets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets ALTER COLUMN id SET DEFAULT nextval('public.password_resets_id_seq'::regclass);


--
-- Name: payment_reminders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reminders ALTER COLUMN id SET DEFAULT nextval('public.payment_reminders_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions ALTER COLUMN id SET DEFAULT nextval('public.permissions_id_seq'::regclass);


--
-- Name: product_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images ALTER COLUMN id SET DEFAULT nextval('public.product_images_id_seq'::regclass);


--
-- Name: products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);


--
-- Name: record_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_history ALTER COLUMN id SET DEFAULT nextval('public.record_history_id_seq'::regclass);


--
-- Name: recurring_invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices ALTER COLUMN id SET DEFAULT nextval('public.recurring_invoices_id_seq'::regclass);


--
-- Name: reminder_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_settings ALTER COLUMN id SET DEFAULT nextval('public.reminder_settings_id_seq'::regclass);


--
-- Name: role_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions ALTER COLUMN id SET DEFAULT nextval('public.role_permissions_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: sales_person_customers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers ALTER COLUMN id SET DEFAULT nextval('public.sales_person_customers_id_seq'::regclass);


--
-- Name: sales_person_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations ALTER COLUMN id SET DEFAULT nextval('public.sales_person_locations_id_seq'::regclass);


--
-- Name: sales_persons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_persons ALTER COLUMN id SET DEFAULT nextval('public.sales_persons_id_seq'::regclass);


--
-- Name: settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings ALTER COLUMN id SET DEFAULT nextval('public.settings_id_seq'::regclass);


--
-- Name: stock_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments ALTER COLUMN id SET DEFAULT nextval('public.stock_adjustments_id_seq'::regclass);


--
-- Name: subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);


--
-- Name: suppliers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers ALTER COLUMN id SET DEFAULT nextval('public.suppliers_id_seq'::regclass);


--
-- Name: system_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);


--
-- Name: tally_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_groups ALTER COLUMN id SET DEFAULT nextval('public.tally_groups_id_seq'::regclass);


--
-- Name: tally_inventory_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_inventory_entries ALTER COLUMN id SET DEFAULT nextval('public.tally_inventory_entries_id_seq'::regclass);


--
-- Name: tally_ledgers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_ledgers ALTER COLUMN id SET DEFAULT nextval('public.tally_ledgers_id_seq'::regclass);


--
-- Name: tally_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_reports ALTER COLUMN id SET DEFAULT nextval('public.tally_reports_id_seq'::regclass);


--
-- Name: tally_sync_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_logs ALTER COLUMN id SET DEFAULT nextval('public.tally_sync_logs_id_seq'::regclass);


--
-- Name: tally_sync_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_state ALTER COLUMN id SET DEFAULT nextval('public.tally_sync_state_id_seq'::regclass);


--
-- Name: tally_voucher_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_voucher_entries ALTER COLUMN id SET DEFAULT nextval('public.tally_voucher_entries_id_seq'::regclass);


--
-- Name: user_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: agent_commands agent_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_pkey PRIMARY KEY (id);


--
-- Name: agent_releases agent_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_releases
    ADD CONSTRAINT agent_releases_pkey PRIMARY KEY (id);


--
-- Name: app_releases app_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_pkey PRIMARY KEY (id);


--
-- Name: bank_transactions bank_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_unique UNIQUE (slug);


--
-- Name: customer_groups customer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups
    ADD CONSTRAINT customer_groups_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: einvoice_api_logs einvoice_api_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_api_logs
    ADD CONSTRAINT einvoice_api_logs_pkey PRIMARY KEY (id);


--
-- Name: einvoice_audit_logs einvoice_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_audit_logs
    ADD CONSTRAINT einvoice_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: einvoice_cancellation_history einvoice_cancellation_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_cancellation_history
    ADD CONSTRAINT einvoice_cancellation_history_pkey PRIMARY KEY (id);


--
-- Name: einvoice_jobs einvoice_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_jobs
    ADD CONSTRAINT einvoice_jobs_pkey PRIMARY KEY (id);


--
-- Name: einvoice_print_logs einvoice_print_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_print_logs
    ADD CONSTRAINT einvoice_print_logs_pkey PRIMARY KEY (id);


--
-- Name: einvoice_settings einvoice_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_settings
    ADD CONSTRAINT einvoice_settings_pkey PRIMARY KEY (id);


--
-- Name: einvoice_transport_history einvoice_transport_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_transport_history
    ADD CONSTRAINT einvoice_transport_history_pkey PRIMARY KEY (id);


--
-- Name: einvoice_validity_history einvoice_validity_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_validity_history
    ADD CONSTRAINT einvoice_validity_history_pkey PRIMARY KEY (id);


--
-- Name: einvoices einvoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices
    ADD CONSTRAINT einvoices_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: field_attendance field_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance
    ADD CONSTRAINT field_attendance_pkey PRIMARY KEY (id);


--
-- Name: field_locations field_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations
    ADD CONSTRAINT field_locations_pkey PRIMARY KEY (id);


--
-- Name: field_visits field_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_pkey PRIMARY KEY (id);


--
-- Name: gps_settings gps_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gps_settings
    ADD CONSTRAINT gps_settings_pkey PRIMARY KEY (id);


--
-- Name: gsp_credentials gsp_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_credentials
    ADD CONSTRAINT gsp_credentials_pkey PRIMARY KEY (id);


--
-- Name: gsp_tokens gsp_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_tokens
    ADD CONSTRAINT gsp_tokens_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: journals journals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journals
    ADD CONSTRAINT journals_pkey PRIMARY KEY (id);


--
-- Name: knex_migrations_lock knex_migrations_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations_lock
    ADD CONSTRAINT knex_migrations_lock_pkey PRIMARY KEY (index);


--
-- Name: knex_migrations knex_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knex_migrations
    ADD CONSTRAINT knex_migrations_pkey PRIMARY KEY (id);


--
-- Name: license_permissions license_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_pkey PRIMARY KEY (id);


--
-- Name: licenses licenses_key_prefix_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_key_prefix_unique UNIQUE (key_prefix);


--
-- Name: licenses licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (id);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (id);


--
-- Name: part_visits part_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits
    ADD CONSTRAINT part_visits_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: payment_reminders payment_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reminders
    ADD CONSTRAINT payment_reminders_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_slug_unique UNIQUE (slug);


--
-- Name: product_images product_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: record_history record_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_history
    ADD CONSTRAINT record_history_pkey PRIMARY KEY (id);


--
-- Name: recurring_invoices recurring_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_pkey PRIMARY KEY (id);


--
-- Name: reminder_settings reminder_settings_license_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_license_id_unique UNIQUE (license_id);


--
-- Name: reminder_settings reminder_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sales_person_customers sales_person_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT sales_person_customers_pkey PRIMARY KEY (id);


--
-- Name: sales_person_locations sales_person_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations
    ADD CONSTRAINT sales_person_locations_pkey PRIMARY KEY (id);


--
-- Name: sales_persons sales_persons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_persons
    ADD CONSTRAINT sales_persons_pkey PRIMARY KEY (id);


--
-- Name: sessions session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: stock_adjustments stock_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_key_unique UNIQUE (key);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: tally_groups tally_groups_company_id_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_groups
    ADD CONSTRAINT tally_groups_company_id_name_unique UNIQUE (company_id, name);


--
-- Name: tally_groups tally_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_groups
    ADD CONSTRAINT tally_groups_pkey PRIMARY KEY (id);


--
-- Name: tally_inventory_entries tally_inventory_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_inventory_entries
    ADD CONSTRAINT tally_inventory_entries_pkey PRIMARY KEY (id);


--
-- Name: tally_ledgers tally_ledgers_company_id_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_ledgers
    ADD CONSTRAINT tally_ledgers_company_id_name_unique UNIQUE (company_id, name);


--
-- Name: tally_ledgers tally_ledgers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_ledgers
    ADD CONSTRAINT tally_ledgers_pkey PRIMARY KEY (id);


--
-- Name: tally_reports tally_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_reports
    ADD CONSTRAINT tally_reports_pkey PRIMARY KEY (id);


--
-- Name: tally_sync_logs tally_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_logs
    ADD CONSTRAINT tally_sync_logs_pkey PRIMARY KEY (id);


--
-- Name: tally_sync_state tally_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_state
    ADD CONSTRAINT tally_sync_state_pkey PRIMARY KEY (id);


--
-- Name: tally_voucher_entries tally_voucher_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_voucher_entries
    ADD CONSTRAINT tally_voucher_entries_pkey PRIMARY KEY (id);


--
-- Name: einvoice_settings uq_einvoice_settings_license; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_settings
    ADD CONSTRAINT uq_einvoice_settings_license UNIQUE (license_id);


--
-- Name: einvoices uq_einvoices_invoice; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices
    ADD CONSTRAINT uq_einvoices_invoice UNIQUE (invoice_id);


--
-- Name: field_attendance uq_field_attendance_sp_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance
    ADD CONSTRAINT uq_field_attendance_sp_day UNIQUE (sales_person_id, day);


--
-- Name: gps_settings uq_gps_settings_license; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gps_settings
    ADD CONSTRAINT uq_gps_settings_license UNIQUE (license_id);


--
-- Name: gsp_credentials uq_gsp_cred_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_credentials
    ADD CONSTRAINT uq_gsp_cred_scope UNIQUE (license_id, provider, env, gstin);


--
-- Name: gsp_tokens uq_gsp_token_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_tokens
    ADD CONSTRAINT uq_gsp_token_scope UNIQUE (license_id, provider, env, gstin);


--
-- Name: inventory uq_inventory_company_product_location; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT uq_inventory_company_product_location UNIQUE (company_id, product_id, location_id);


--
-- Name: license_permissions uq_license_permissions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT uq_license_permissions UNIQUE (license_id, permission_id);


--
-- Name: notification_reads uq_notif_read_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT uq_notif_read_user_key UNIQUE (user_id, notification_key);


--
-- Name: permissions uq_permissions_module_action; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT uq_permissions_module_action UNIQUE (module, action);


--
-- Name: role_permissions uq_role_permissions_role_perm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT uq_role_permissions_role_perm UNIQUE (role_id, permission_id);


--
-- Name: roles uq_roles_company_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT uq_roles_company_slug UNIQUE (company_id, slug);


--
-- Name: roles uq_roles_license_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT uq_roles_license_slug UNIQUE (license_id, slug);


--
-- Name: settings uq_settings_company_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT uq_settings_company_key UNIQUE (company_id, key);


--
-- Name: sales_person_customers uq_spc_sp_customer_location; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT uq_spc_sp_customer_location UNIQUE (sales_person_id, customer_id, location_id);


--
-- Name: sales_person_locations uq_spl_sales_person_location; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations
    ADD CONSTRAINT uq_spl_sales_person_location UNIQUE (sales_person_id, location_id);


--
-- Name: tally_reports uq_tally_reports_company_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_reports
    ADD CONSTRAINT uq_tally_reports_company_type UNIQUE (company_id, report_type);


--
-- Name: tally_sync_state uq_tally_sync_state_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_state
    ADD CONSTRAINT uq_tally_sync_state_company UNIQUE (company_id);


--
-- Name: user_sessions user_sessions_jti_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_jti_unique UNIQUE (jti);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);


--
-- Name: agent_commands_license_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_commands_license_id_status_index ON public.agent_commands USING btree (license_id, status);


--
-- Name: agent_releases_is_current_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_releases_is_current_index ON public.agent_releases USING btree (is_current);


--
-- Name: app_releases_is_current_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_releases_is_current_index ON public.app_releases USING btree (is_current);


--
-- Name: idx_bank_txn_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_txn_company_date ON public.bank_transactions USING btree (company_id, txn_date);


--
-- Name: idx_bank_txn_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_txn_company_status ON public.bank_transactions USING btree (company_id, status);


--
-- Name: idx_categories_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_company_id ON public.categories USING btree (company_id);


--
-- Name: idx_categories_company_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_company_lname ON public.categories USING btree (company_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_categories_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_parent_id ON public.categories USING btree (parent_id);


--
-- Name: idx_companies_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_deleted_at ON public.companies USING btree (deleted_at);


--
-- Name: idx_companies_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_license ON public.companies USING btree (license_id);


--
-- Name: idx_companies_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_slug ON public.companies USING btree (slug);


--
-- Name: idx_companies_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_status ON public.companies USING btree (status);


--
-- Name: idx_customer_groups_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_groups_company_id ON public.customer_groups USING btree (company_id);


--
-- Name: idx_customers_company_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_company_lname ON public.customers USING btree (company_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_customers_company_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_company_location ON public.customers USING btree (company_id, location_id);


--
-- Name: idx_customers_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_company_status ON public.customers USING btree (company_id, status);


--
-- Name: idx_eapilogs_company_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eapilogs_company_action ON public.einvoice_api_logs USING btree (company_id, action);


--
-- Name: idx_eapilogs_company_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eapilogs_company_einvoice ON public.einvoice_api_logs USING btree (company_id, einvoice_id);


--
-- Name: idx_eapilogs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eapilogs_created_at ON public.einvoice_api_logs USING btree (created_at);


--
-- Name: idx_eaudit_company_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eaudit_company_einvoice ON public.einvoice_audit_logs USING btree (company_id, einvoice_id);


--
-- Name: idx_ecancel_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecancel_einvoice ON public.einvoice_cancellation_history USING btree (einvoice_id);


--
-- Name: idx_einvoice_jobs_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_einvoice_jobs_due ON public.einvoice_jobs USING btree (status, next_run_at);


--
-- Name: idx_einvoices_company_ewb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_einvoices_company_ewb ON public.einvoices USING btree (company_id, ewb_status);


--
-- Name: idx_einvoices_company_irp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_einvoices_company_irp ON public.einvoices USING btree (company_id, irp_status);


--
-- Name: idx_einvoices_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_einvoices_company_status ON public.einvoices USING btree (company_id, status);


--
-- Name: idx_einvoices_dedup_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_einvoices_dedup_hash ON public.einvoices USING btree (dedup_hash);


--
-- Name: idx_eprint_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eprint_einvoice ON public.einvoice_print_logs USING btree (einvoice_id);


--
-- Name: idx_etransport_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etransport_einvoice ON public.einvoice_transport_history USING btree (einvoice_id);


--
-- Name: idx_evalidity_einvoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evalidity_einvoice ON public.einvoice_validity_history USING btree (einvoice_id);


--
-- Name: idx_expense_categories_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expense_categories_company ON public.expense_categories USING btree (company_id);


--
-- Name: idx_expenses_company_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_company_category ON public.expenses USING btree (company_id, category_id);


--
-- Name: idx_expenses_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_company_date ON public.expenses USING btree (company_id, expense_date);


--
-- Name: idx_field_attendance_company_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_attendance_company_day ON public.field_attendance USING btree (company_id, day);


--
-- Name: idx_field_visits_checkin_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_visits_checkin_at ON public.field_visits USING btree (checkin_at);


--
-- Name: idx_field_visits_company_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_visits_company_customer ON public.field_visits USING btree (company_id, customer_id);


--
-- Name: idx_field_visits_company_sp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_field_visits_company_sp ON public.field_visits USING btree (company_id, sales_person_id);


--
-- Name: idx_floc_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_floc_captured_at ON public.field_locations USING btree (captured_at);


--
-- Name: idx_floc_company_sp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_floc_company_sp ON public.field_locations USING btree (company_id, sales_person_id);


--
-- Name: idx_inventory_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_company_id ON public.inventory USING btree (company_id);


--
-- Name: idx_inventory_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_product_id ON public.inventory USING btree (product_id);


--
-- Name: idx_invoice_items_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_company_id ON public.invoice_items USING btree (company_id);


--
-- Name: idx_invoice_items_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items USING btree (invoice_id);


--
-- Name: idx_invoices_company_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_approval ON public.invoices USING btree (company_id, approval_status);


--
-- Name: idx_invoices_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_date ON public.invoices USING btree (company_id, invoice_date);


--
-- Name: idx_invoices_company_tvno; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_tvno ON public.invoices USING btree (company_id, tally_voucher_no) WHERE (deleted_at IS NULL);


--
-- Name: idx_invoices_company_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_type_status ON public.invoices USING btree (company_id, type, status);


--
-- Name: idx_license_permissions_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_license_permissions_license ON public.license_permissions USING btree (license_id);


--
-- Name: idx_licenses_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_status ON public.licenses USING btree (status);


--
-- Name: idx_locations_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_locations_company_id ON public.locations USING btree (company_id);


--
-- Name: idx_locations_company_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_locations_company_lname ON public.locations USING btree (company_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_locations_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_locations_company_status ON public.locations USING btree (company_id, status);


--
-- Name: idx_notification_reads_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_reads_user_id ON public.notification_reads USING btree (user_id);


--
-- Name: idx_partvisit_company_sp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partvisit_company_sp ON public.part_visits USING btree (company_id, sales_person_id);


--
-- Name: idx_password_resets_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_email ON public.password_resets USING btree (email);


--
-- Name: idx_password_resets_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_token ON public.password_resets USING btree (token);


--
-- Name: idx_payments_company_tvno; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_company_tvno ON public.payments USING btree (company_id, tally_voucher_no) WHERE (deleted_at IS NULL);


--
-- Name: idx_payments_company_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_company_type ON public.payments USING btree (company_id, type);


--
-- Name: idx_permissions_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_permissions_module ON public.permissions USING btree (module);


--
-- Name: idx_product_images_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_images_product ON public.product_images USING btree (company_id, product_id);


--
-- Name: idx_products_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_company_id ON public.products USING btree (company_id);


--
-- Name: idx_products_company_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_company_lname ON public.products USING btree (company_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_products_company_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_company_sku ON public.products USING btree (company_id, sku);


--
-- Name: idx_record_history_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_record_history_company_created ON public.record_history USING btree (company_id, created_at);


--
-- Name: idx_record_history_company_module_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_record_history_company_module_record ON public.record_history USING btree (company_id, module, record_id);


--
-- Name: idx_recurring_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_company_status ON public.recurring_invoices USING btree (company_id, status);


--
-- Name: idx_recurring_next_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_next_run ON public.recurring_invoices USING btree (next_run_date);


--
-- Name: idx_reminders_company_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reminders_company_customer ON public.payment_reminders USING btree (company_id, customer_id);


--
-- Name: idx_reminders_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reminders_dedupe ON public.payment_reminders USING btree (company_id, customer_id, offset_day);


--
-- Name: idx_role_permissions_permission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_permission_id ON public.role_permissions USING btree (permission_id);


--
-- Name: idx_role_permissions_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_role_id ON public.role_permissions USING btree (role_id);


--
-- Name: idx_roles_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_company_id ON public.roles USING btree (company_id);


--
-- Name: idx_roles_license_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_license_id ON public.roles USING btree (license_id);


--
-- Name: idx_roles_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_slug ON public.roles USING btree (slug);


--
-- Name: idx_sales_persons_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_persons_company_id ON public.sales_persons USING btree (company_id);


--
-- Name: idx_sales_persons_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_persons_company_status ON public.sales_persons USING btree (company_id, status);


--
-- Name: idx_settings_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settings_company_id ON public.settings USING btree (company_id);


--
-- Name: idx_spc_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spc_company_id ON public.sales_person_customers USING btree (company_id);


--
-- Name: idx_spc_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spc_customer_id ON public.sales_person_customers USING btree (customer_id);


--
-- Name: idx_spc_location_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spc_location_id ON public.sales_person_customers USING btree (location_id);


--
-- Name: idx_spc_sales_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spc_sales_person_id ON public.sales_person_customers USING btree (sales_person_id);


--
-- Name: idx_spl_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spl_company_id ON public.sales_person_locations USING btree (company_id);


--
-- Name: idx_spl_location_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spl_location_id ON public.sales_person_locations USING btree (location_id);


--
-- Name: idx_spl_sales_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spl_sales_person_id ON public.sales_person_locations USING btree (sales_person_id);


--
-- Name: idx_subscriptions_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_status ON public.subscriptions USING btree (user_id, status);


--
-- Name: idx_suppliers_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_company_id ON public.suppliers USING btree (company_id);


--
-- Name: idx_suppliers_company_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_company_lname ON public.suppliers USING btree (company_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_suppliers_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_company_status ON public.suppliers USING btree (company_id, status);


--
-- Name: idx_synclogs_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synclogs_company_created ON public.tally_sync_logs USING btree (company_id, created_at);


--
-- Name: idx_tally_sync_logs_company_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tally_sync_logs_company_module ON public.tally_sync_logs USING btree (company_id, module);


--
-- Name: idx_tally_sync_logs_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tally_sync_logs_company_status ON public.tally_sync_logs USING btree (company_id, status);


--
-- Name: idx_user_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user ON public.user_sessions USING btree (user_id);


--
-- Name: idx_users_approval_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_approval_status ON public.users USING btree (approval_status);


--
-- Name: idx_users_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_company_id ON public.users USING btree (company_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_license ON public.users USING btree (license_id);


--
-- Name: idx_users_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role_id ON public.users USING btree (role_id);


--
-- Name: invoices_company_type_vtype_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_company_type_vtype_idx ON public.invoices USING btree (company_id, type, tally_voucher_type);


--
-- Name: journals_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journals_company_id_index ON public.journals USING btree (company_id);


--
-- Name: stock_adjustments_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_adjustments_company_id_index ON public.stock_adjustments USING btree (company_id);


--
-- Name: tally_groups_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_groups_company_id_index ON public.tally_groups USING btree (company_id);


--
-- Name: tally_inventory_entries_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_inventory_entries_company_id_index ON public.tally_inventory_entries USING btree (company_id);


--
-- Name: tally_inventory_entries_company_id_item_name_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_inventory_entries_company_id_item_name_index ON public.tally_inventory_entries USING btree (company_id, item_name);


--
-- Name: tally_inventory_entries_voucher_guid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_inventory_entries_voucher_guid_index ON public.tally_inventory_entries USING btree (voucher_guid);


--
-- Name: tally_ledgers_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_ledgers_company_id_index ON public.tally_ledgers USING btree (company_id);


--
-- Name: tally_voucher_entries_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_voucher_entries_company_id_index ON public.tally_voucher_entries USING btree (company_id);


--
-- Name: tally_voucher_entries_company_id_ledger_name_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_voucher_entries_company_id_ledger_name_index ON public.tally_voucher_entries USING btree (company_id, ledger_name);


--
-- Name: tally_voucher_entries_voucher_guid_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tally_voucher_entries_voucher_guid_index ON public.tally_voucher_entries USING btree (voucher_guid);


--
-- Name: uq_invoices_cloud_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoices_cloud_no ON public.invoices USING btree (company_id, type, invoice_no) WHERE (tally_guid IS NULL);


--
-- Name: uq_invoices_tally_guid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_invoices_tally_guid ON public.invoices USING btree (company_id, tally_guid) WHERE (tally_guid IS NOT NULL);


--
-- Name: uq_payments_cloud_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payments_cloud_no ON public.payments USING btree (company_id, type, voucher_no) WHERE (tally_guid IS NULL);


--
-- Name: uq_payments_tally_guid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payments_tally_guid ON public.payments USING btree (company_id, tally_guid) WHERE (tally_guid IS NOT NULL);


--
-- Name: agent_commands agent_commands_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: agent_commands agent_commands_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_commands agent_commands_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: bank_transactions bank_transactions_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_transactions
    ADD CONSTRAINT bank_transactions_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: categories categories_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: categories categories_parent_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_foreign FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: companies companies_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE SET NULL;


--
-- Name: customer_groups customer_groups_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups
    ADD CONSTRAINT customer_groups_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: customers customers_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: customers customers_customer_group_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_customer_group_id_foreign FOREIGN KEY (customer_group_id) REFERENCES public.customer_groups(id) ON DELETE SET NULL;


--
-- Name: customers customers_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: customers customers_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE SET NULL;


--
-- Name: einvoice_api_logs einvoice_api_logs_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_api_logs
    ADD CONSTRAINT einvoice_api_logs_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_api_logs einvoice_api_logs_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_api_logs
    ADD CONSTRAINT einvoice_api_logs_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_api_logs einvoice_api_logs_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_api_logs
    ADD CONSTRAINT einvoice_api_logs_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_audit_logs einvoice_audit_logs_actor_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_audit_logs
    ADD CONSTRAINT einvoice_audit_logs_actor_id_foreign FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_audit_logs einvoice_audit_logs_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_audit_logs
    ADD CONSTRAINT einvoice_audit_logs_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_audit_logs einvoice_audit_logs_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_audit_logs
    ADD CONSTRAINT einvoice_audit_logs_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_cancellation_history einvoice_cancellation_history_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_cancellation_history
    ADD CONSTRAINT einvoice_cancellation_history_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_cancellation_history einvoice_cancellation_history_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_cancellation_history
    ADD CONSTRAINT einvoice_cancellation_history_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_cancellation_history einvoice_cancellation_history_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_cancellation_history
    ADD CONSTRAINT einvoice_cancellation_history_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_jobs einvoice_jobs_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_jobs
    ADD CONSTRAINT einvoice_jobs_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_jobs einvoice_jobs_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_jobs
    ADD CONSTRAINT einvoice_jobs_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_print_logs einvoice_print_logs_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_print_logs
    ADD CONSTRAINT einvoice_print_logs_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_print_logs einvoice_print_logs_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_print_logs
    ADD CONSTRAINT einvoice_print_logs_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_print_logs einvoice_print_logs_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_print_logs
    ADD CONSTRAINT einvoice_print_logs_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_settings einvoice_settings_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_settings
    ADD CONSTRAINT einvoice_settings_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: einvoice_settings einvoice_settings_updated_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_settings
    ADD CONSTRAINT einvoice_settings_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_transport_history einvoice_transport_history_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_transport_history
    ADD CONSTRAINT einvoice_transport_history_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_transport_history einvoice_transport_history_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_transport_history
    ADD CONSTRAINT einvoice_transport_history_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_transport_history einvoice_transport_history_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_transport_history
    ADD CONSTRAINT einvoice_transport_history_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoice_validity_history einvoice_validity_history_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_validity_history
    ADD CONSTRAINT einvoice_validity_history_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoice_validity_history einvoice_validity_history_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_validity_history
    ADD CONSTRAINT einvoice_validity_history_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoice_validity_history einvoice_validity_history_einvoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoice_validity_history
    ADD CONSTRAINT einvoice_validity_history_einvoice_id_foreign FOREIGN KEY (einvoice_id) REFERENCES public.einvoices(id) ON DELETE CASCADE;


--
-- Name: einvoices einvoices_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices
    ADD CONSTRAINT einvoices_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: einvoices einvoices_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices
    ADD CONSTRAINT einvoices_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: einvoices einvoices_invoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.einvoices
    ADD CONSTRAINT einvoices_invoice_id_foreign FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: expense_categories expense_categories_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_category_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_category_id_foreign FOREIGN KEY (category_id) REFERENCES public.expense_categories(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: field_attendance field_attendance_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance
    ADD CONSTRAINT field_attendance_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: field_attendance field_attendance_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance
    ADD CONSTRAINT field_attendance_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: field_attendance field_attendance_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_attendance
    ADD CONSTRAINT field_attendance_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: field_locations field_locations_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations
    ADD CONSTRAINT field_locations_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: field_locations field_locations_part_visit_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations
    ADD CONSTRAINT field_locations_part_visit_id_foreign FOREIGN KEY (part_visit_id) REFERENCES public.part_visits(id) ON DELETE SET NULL;


--
-- Name: field_locations field_locations_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations
    ADD CONSTRAINT field_locations_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: field_locations field_locations_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_locations
    ADD CONSTRAINT field_locations_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: field_visits field_visits_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: field_visits field_visits_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: field_visits field_visits_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: field_visits field_visits_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: field_visits field_visits_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gps_settings gps_settings_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gps_settings
    ADD CONSTRAINT gps_settings_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: gps_settings gps_settings_updated_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gps_settings
    ADD CONSTRAINT gps_settings_updated_by_foreign FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gsp_credentials gsp_credentials_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_credentials
    ADD CONSTRAINT gsp_credentials_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gsp_credentials gsp_credentials_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_credentials
    ADD CONSTRAINT gsp_credentials_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: gsp_tokens gsp_tokens_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gsp_tokens
    ADD CONSTRAINT gsp_tokens_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: inventory inventory_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: inventory inventory_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: inventory inventory_product_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_product_id_foreign FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_invoice_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_foreign FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_product_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_product_id_foreign FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_approved_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_approved_by_foreign FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_supplier_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_supplier_id_foreign FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: license_permissions license_permissions_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: license_permissions license_permissions_permission_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_permissions
    ADD CONSTRAINT license_permissions_permission_id_foreign FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: locations locations_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: part_visits part_visits_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits
    ADD CONSTRAINT part_visits_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: part_visits part_visits_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits
    ADD CONSTRAINT part_visits_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: part_visits part_visits_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits
    ADD CONSTRAINT part_visits_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: part_visits part_visits_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.part_visits
    ADD CONSTRAINT part_visits_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payment_reminders payment_reminders_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reminders
    ADD CONSTRAINT payment_reminders_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payment_reminders payment_reminders_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reminders
    ADD CONSTRAINT payment_reminders_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: payment_reminders payment_reminders_sent_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reminders
    ADD CONSTRAINT payment_reminders_sent_by_foreign FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payments payments_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: payments payments_supplier_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_supplier_id_foreign FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: product_images product_images_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: product_images product_images_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: product_images product_images_product_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_foreign FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_category_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_foreign FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: products products_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: record_history record_history_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_history
    ADD CONSTRAINT record_history_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: recurring_invoices recurring_invoices_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: recurring_invoices recurring_invoices_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: recurring_invoices recurring_invoices_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: reminder_settings reminder_settings_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_permission_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_foreign FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: roles roles_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: roles roles_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE CASCADE;


--
-- Name: sales_person_customers sales_person_customers_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT sales_person_customers_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_person_customers sales_person_customers_customer_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT sales_person_customers_customer_id_foreign FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: sales_person_customers sales_person_customers_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT sales_person_customers_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE;


--
-- Name: sales_person_customers sales_person_customers_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_customers
    ADD CONSTRAINT sales_person_customers_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: sales_person_locations sales_person_locations_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations
    ADD CONSTRAINT sales_person_locations_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_person_locations sales_person_locations_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations
    ADD CONSTRAINT sales_person_locations_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE;


--
-- Name: sales_person_locations sales_person_locations_sales_person_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_person_locations
    ADD CONSTRAINT sales_person_locations_sales_person_id_foreign FOREIGN KEY (sales_person_id) REFERENCES public.sales_persons(id) ON DELETE CASCADE;


--
-- Name: sales_persons sales_persons_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_persons
    ADD CONSTRAINT sales_persons_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_persons sales_persons_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_persons
    ADD CONSTRAINT sales_persons_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: settings settings_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_adjustments stock_adjustments_product_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_product_id_foreign FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: tally_reports tally_reports_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_reports
    ADD CONSTRAINT tally_reports_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: tally_sync_logs tally_sync_logs_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_logs
    ADD CONSTRAINT tally_sync_logs_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: tally_sync_state tally_sync_state_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tally_sync_state
    ADD CONSTRAINT tally_sync_state_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_approved_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_approved_by_foreign FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: users users_license_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_license_id_foreign FOREIGN KEY (license_id) REFERENCES public.licenses(id) ON DELETE SET NULL;


--
-- Name: users users_location_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_location_id_foreign FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: users users_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

