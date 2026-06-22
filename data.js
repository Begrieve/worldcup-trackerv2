// ============================================================================
//  2026 FIFA World Cup — static tournament data
//  Hosts: USA, Canada, Mexico  |  48 teams, 12 groups, 72 group-stage matches
//  Group stage: June 11 – June 27, 2026
//  All kickoff times below are U.S. Eastern Time (ET).
//  Playoff slots resolved with the March 2026 winners:
//    Bosnia & Herzegovina, Sweden, Türkiye, Czechia (UEFA),
//    DR Congo, Iraq (inter-confederation).
// ============================================================================

// Flag emoji per team (England/Scotland use subdivision tag sequences).
const FLAGS = {
  "Mexico": "🇲🇽", "South Africa": "🇿🇦", "South Korea": "🇰🇷", "Czechia": "🇨🇿",
  "Canada": "🇨🇦", "Bosnia & Herzegovina": "🇧🇦", "Qatar": "🇶🇦", "Switzerland": "🇨🇭",
  "Brazil": "🇧🇷", "Morocco": "🇲🇦", "Haiti": "🇭🇹", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "USA": "🇺🇸", "Paraguay": "🇵🇾", "Australia": "🇦🇺", "Türkiye": "🇹🇷",
  "Germany": "🇩🇪", "Curaçao": "🇨🇼", "Ivory Coast": "🇨🇮", "Ecuador": "🇪🇨",
  "Netherlands": "🇳🇱", "Japan": "🇯🇵", "Tunisia": "🇹🇳", "Sweden": "🇸🇪",
  "Belgium": "🇧🇪", "Egypt": "🇪🇬", "Iran": "🇮🇷", "New Zealand": "🇳🇿",
  "Spain": "🇪🇸", "Cape Verde": "🇨🇻", "Saudi Arabia": "🇸🇦", "Uruguay": "🇺🇾",
  "France": "🇫🇷", "Senegal": "🇸🇳", "Iraq": "🇮🇶", "Norway": "🇳🇴",
  "Argentina": "🇦🇷", "Algeria": "🇩🇿", "Austria": "🇦🇹", "Jordan": "🇯🇴",
  "Portugal": "🇵🇹", "DR Congo": "🇨🇩", "Uzbekistan": "🇺🇿", "Colombia": "🇨🇴",
  "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Croatia": "🇭🇷", "Ghana": "🇬🇭", "Panama": "🇵🇦"
};

// Group composition (draw order).
const GROUPS = {
  A: ["Mexico", "South Africa", "South Korea", "Czechia"],
  B: ["Canada", "Bosnia & Herzegovina", "Qatar", "Switzerland"],
  C: ["Brazil", "Morocco", "Haiti", "Scotland"],
  D: ["USA", "Paraguay", "Australia", "Türkiye"],
  E: ["Germany", "Curaçao", "Ivory Coast", "Ecuador"],
  F: ["Netherlands", "Japan", "Tunisia", "Sweden"],
  G: ["Belgium", "Egypt", "Iran", "New Zealand"],
  H: ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
  I: ["France", "Senegal", "Iraq", "Norway"],
  J: ["Argentina", "Algeria", "Austria", "Jordan"],
  K: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
  L: ["England", "Croatia", "Ghana", "Panama"]
};

// City label (as broadcast) -> { stadium, city, country }
const VENUES = {
  "Mexico City":            { stadium: "Estadio Azteca",         city: "Mexico City",       country: "Mexico" },
  "Guadalajara":            { stadium: "Estadio Akron",          city: "Guadalajara",       country: "Mexico" },
  "Monterrey":              { stadium: "Estadio BBVA",           city: "Monterrey",         country: "Mexico" },
  "Toronto":                { stadium: "BMO Field",              city: "Toronto",           country: "Canada" },
  "Vancouver":              { stadium: "BC Place",               city: "Vancouver",         country: "Canada" },
  "Los Angeles":            { stadium: "SoFi Stadium",           city: "Inglewood, CA",     country: "USA" },
  "Seattle":                { stadium: "Lumen Field",            city: "Seattle, WA",       country: "USA" },
  "San Francisco Bay Area": { stadium: "Levi's Stadium",         city: "Santa Clara, CA",   country: "USA" },
  "New York/New Jersey":    { stadium: "MetLife Stadium",        city: "East Rutherford, NJ", country: "USA" },
  "Boston":                 { stadium: "Gillette Stadium",       city: "Foxborough, MA",    country: "USA" },
  "Philadelphia":           { stadium: "Lincoln Financial Field",city: "Philadelphia, PA",  country: "USA" },
  "Houston":                { stadium: "NRG Stadium",            city: "Houston, TX",       country: "USA" },
  "Dallas":                 { stadium: "AT&T Stadium",           city: "Arlington, TX",     country: "USA" },
  "Kansas City":            { stadium: "Arrowhead Stadium",      city: "Kansas City, MO",   country: "USA" },
  "Atlanta":                { stadium: "Mercedes-Benz Stadium",  city: "Atlanta, GA",       country: "USA" },
  "Miami":                  { stadium: "Hard Rock Stadium",      city: "Miami Gardens, FL", country: "USA" }
};

// All 72 group-stage matches.
// [date(ET listing), kickoffISO(ET), timeLabel, group, home, away, cityLabel]
const RAW = [
  // June 11
  ["2026-06-11","2026-06-11T15:00:00-04:00","3:00 PM ET","A","Mexico","South Africa","Mexico City"],
  ["2026-06-11","2026-06-11T22:00:00-04:00","10:00 PM ET","A","South Korea","Czechia","Guadalajara"],
  // June 12
  ["2026-06-12","2026-06-12T15:00:00-04:00","3:00 PM ET","B","Canada","Bosnia & Herzegovina","Toronto"],
  ["2026-06-12","2026-06-12T21:00:00-04:00","9:00 PM ET","D","USA","Paraguay","Los Angeles"],
  // June 13
  ["2026-06-13","2026-06-13T15:00:00-04:00","3:00 PM ET","C","Brazil","Morocco","New York/New Jersey"],
  ["2026-06-13","2026-06-13T18:00:00-04:00","6:00 PM ET","D","Australia","Türkiye","Vancouver"],
  ["2026-06-13","2026-06-13T21:00:00-04:00","9:00 PM ET","C","Haiti","Scotland","Boston"],
  ["2026-06-13","2026-06-14T00:00:00-04:00","12:00 AM ET","B","Qatar","Switzerland","San Francisco Bay Area"],
  // June 14
  ["2026-06-14","2026-06-14T13:00:00-04:00","1:00 PM ET","E","Germany","Curaçao","Houston"],
  ["2026-06-14","2026-06-14T16:00:00-04:00","4:00 PM ET","E","Ivory Coast","Ecuador","Philadelphia"],
  ["2026-06-14","2026-06-14T19:00:00-04:00","7:00 PM ET","F","Netherlands","Japan","Dallas"],
  ["2026-06-14","2026-06-14T22:00:00-04:00","10:00 PM ET","F","Sweden","Tunisia","Monterrey"],
  // June 15
  ["2026-06-15","2026-06-15T12:00:00-04:00","12:00 PM ET","H","Spain","Cape Verde","Atlanta"],
  ["2026-06-15","2026-06-15T15:00:00-04:00","3:00 PM ET","G","Belgium","Egypt","Seattle"],
  ["2026-06-15","2026-06-15T18:00:00-04:00","6:00 PM ET","H","Saudi Arabia","Uruguay","Miami"],
  ["2026-06-15","2026-06-15T21:00:00-04:00","9:00 PM ET","G","Iran","New Zealand","Los Angeles"],
  // June 16
  ["2026-06-16","2026-06-16T15:00:00-04:00","3:00 PM ET","I","France","Senegal","New York/New Jersey"],
  ["2026-06-16","2026-06-16T18:00:00-04:00","6:00 PM ET","I","Iraq","Norway","Boston"],
  ["2026-06-16","2026-06-16T21:00:00-04:00","9:00 PM ET","J","Argentina","Algeria","Kansas City"],
  ["2026-06-16","2026-06-17T00:00:00-04:00","12:00 AM ET","J","Austria","Jordan","San Francisco Bay Area"],
  // June 17
  ["2026-06-17","2026-06-17T13:00:00-04:00","1:00 PM ET","K","Portugal","DR Congo","Houston"],
  ["2026-06-17","2026-06-17T16:00:00-04:00","4:00 PM ET","L","England","Croatia","Dallas"],
  ["2026-06-17","2026-06-17T19:00:00-04:00","7:00 PM ET","L","Ghana","Panama","Toronto"],
  ["2026-06-17","2026-06-17T22:00:00-04:00","10:00 PM ET","K","Uzbekistan","Colombia","Mexico City"],
  // June 18
  ["2026-06-18","2026-06-18T12:00:00-04:00","12:00 PM ET","A","Czechia","South Africa","Atlanta"],
  ["2026-06-18","2026-06-18T15:00:00-04:00","3:00 PM ET","B","Switzerland","Bosnia & Herzegovina","Los Angeles"],
  ["2026-06-18","2026-06-18T18:00:00-04:00","6:00 PM ET","B","Canada","Qatar","Vancouver"],
  ["2026-06-18","2026-06-18T21:00:00-04:00","9:00 PM ET","A","Mexico","South Korea","Guadalajara"],
  // June 19
  ["2026-06-19","2026-06-19T15:00:00-04:00","3:00 PM ET","D","USA","Australia","Seattle"],
  ["2026-06-19","2026-06-19T18:00:00-04:00","6:00 PM ET","C","Scotland","Morocco","Boston"],
  ["2026-06-19","2026-06-19T21:00:00-04:00","9:00 PM ET","C","Brazil","Haiti","Philadelphia"],
  ["2026-06-19","2026-06-20T00:00:00-04:00","12:00 AM ET","D","Türkiye","Paraguay","San Francisco Bay Area"],
  // June 20
  ["2026-06-20","2026-06-20T13:00:00-04:00","1:00 PM ET","F","Netherlands","Sweden","Houston"],
  ["2026-06-20","2026-06-20T16:00:00-04:00","4:00 PM ET","E","Germany","Ivory Coast","Toronto"],
  ["2026-06-20","2026-06-20T20:00:00-04:00","8:00 PM ET","E","Ecuador","Curaçao","Kansas City"],
  ["2026-06-20","2026-06-21T00:00:00-04:00","12:00 AM ET","F","Tunisia","Japan","Monterrey"],
  // June 21
  ["2026-06-21","2026-06-21T12:00:00-04:00","12:00 PM ET","H","Spain","Saudi Arabia","Atlanta"],
  ["2026-06-21","2026-06-21T15:00:00-04:00","3:00 PM ET","G","Belgium","Iran","Los Angeles"],
  ["2026-06-21","2026-06-21T18:00:00-04:00","6:00 PM ET","H","Uruguay","Cape Verde","Miami"],
  ["2026-06-21","2026-06-21T21:00:00-04:00","9:00 PM ET","G","New Zealand","Egypt","Vancouver"],
  // June 22
  ["2026-06-22","2026-06-22T13:00:00-04:00","1:00 PM ET","J","Argentina","Austria","Dallas"],
  ["2026-06-22","2026-06-22T17:00:00-04:00","5:00 PM ET","I","France","Iraq","Philadelphia"],
  ["2026-06-22","2026-06-22T20:00:00-04:00","8:00 PM ET","I","Norway","Senegal","New York/New Jersey"],
  ["2026-06-22","2026-06-22T23:00:00-04:00","11:00 PM ET","J","Jordan","Algeria","San Francisco Bay Area"],
  // June 23
  ["2026-06-23","2026-06-23T13:00:00-04:00","1:00 PM ET","K","Portugal","Uzbekistan","Houston"],
  ["2026-06-23","2026-06-23T16:00:00-04:00","4:00 PM ET","L","England","Ghana","Boston"],
  ["2026-06-23","2026-06-23T19:00:00-04:00","7:00 PM ET","L","Panama","Croatia","Toronto"],
  ["2026-06-23","2026-06-23T22:00:00-04:00","10:00 PM ET","K","Colombia","DR Congo","Guadalajara"],
  // June 24
  ["2026-06-24","2026-06-24T15:00:00-04:00","3:00 PM ET","B","Canada","Switzerland","Vancouver"],
  ["2026-06-24","2026-06-24T15:00:00-04:00","3:00 PM ET","B","Bosnia & Herzegovina","Qatar","Seattle"],
  ["2026-06-24","2026-06-24T18:00:00-04:00","6:00 PM ET","C","Scotland","Brazil","Miami"],
  ["2026-06-24","2026-06-24T18:00:00-04:00","6:00 PM ET","C","Morocco","Haiti","Atlanta"],
  ["2026-06-24","2026-06-24T21:00:00-04:00","9:00 PM ET","A","Mexico","Czechia","Mexico City"],
  ["2026-06-24","2026-06-24T21:00:00-04:00","9:00 PM ET","A","South Korea","South Africa","Monterrey"],
  // June 25
  ["2026-06-25","2026-06-25T16:00:00-04:00","4:00 PM ET","E","Ecuador","Germany","New York/New Jersey"],
  ["2026-06-25","2026-06-25T16:00:00-04:00","4:00 PM ET","E","Curaçao","Ivory Coast","Philadelphia"],
  ["2026-06-25","2026-06-25T19:00:00-04:00","7:00 PM ET","F","Tunisia","Netherlands","Kansas City"],
  ["2026-06-25","2026-06-25T19:00:00-04:00","7:00 PM ET","F","Japan","Sweden","Dallas"],
  ["2026-06-25","2026-06-25T22:00:00-04:00","10:00 PM ET","D","USA","Türkiye","Los Angeles"],
  ["2026-06-25","2026-06-25T22:00:00-04:00","10:00 PM ET","D","Paraguay","Australia","San Francisco Bay Area"],
  // June 26
  ["2026-06-26","2026-06-26T15:00:00-04:00","3:00 PM ET","I","Norway","France","Boston"],
  ["2026-06-26","2026-06-26T15:00:00-04:00","3:00 PM ET","I","Senegal","Iraq","Toronto"],
  ["2026-06-26","2026-06-26T13:00:00-04:00","1:00 PM ET","H","Cape Verde","Saudi Arabia","Houston"],
  ["2026-06-26","2026-06-26T20:00:00-04:00","8:00 PM ET","G","New Zealand","Belgium","Vancouver"],
  ["2026-06-26","2026-06-26T20:00:00-04:00","8:00 PM ET","G","Egypt","Iran","Seattle"],
  ["2026-06-26","2026-06-26T23:00:00-04:00","11:00 PM ET","H","Uruguay","Spain","Guadalajara"],
  // June 27
  ["2026-06-27","2026-06-27T17:00:00-04:00","5:00 PM ET","L","Panama","England","New York/New Jersey"],
  ["2026-06-27","2026-06-27T17:00:00-04:00","5:00 PM ET","L","Croatia","Ghana","Philadelphia"],
  ["2026-06-27","2026-06-27T19:30:00-04:00","7:30 PM ET","K","Colombia","Portugal","Miami"],
  ["2026-06-27","2026-06-27T19:30:00-04:00","7:30 PM ET","K","DR Congo","Uzbekistan","Atlanta"],
  ["2026-06-27","2026-06-27T22:00:00-04:00","10:00 PM ET","J","Jordan","Argentina","Dallas"],
  ["2026-06-27","2026-06-27T22:00:00-04:00","10:00 PM ET","J","Algeria","Austria","Kansas City"]
];

const MATCHES = RAW.map((r, i) => {
  const [date, kickoff, time, group, home, away, cityLabel] = r;
  const v = VENUES[cityLabel];
  return {
    id: "M" + String(i + 1).padStart(2, "0"),
    group, date, kickoff, time,
    home, away,
    stadium: v.stadium, city: v.city, country: v.country
  };
});

const TOURNAMENT = {
  name: "FIFA World Cup 2026",
  hosts: ["United States", "Canada", "Mexico"],
  groupStage: "June 11 – June 27, 2026",
  final: "July 19, 2026 · MetLife Stadium, East Rutherford, NJ"
};

module.exports = { FLAGS, GROUPS, VENUES, MATCHES, TOURNAMENT };
